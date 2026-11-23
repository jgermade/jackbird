// The page's side of the phone's player (E6b): Tauri's plugin, whose commands the page calls
// (src/lib/phone-audio.ts) and whose events it hears. It hands PlayerService's player the song to
// play and the songs ahead of it, all at once, since the page may not be able to ask the instance
// for the next one in the background (E6-D1 c); the player goes through them by itself and says so.

package es.germade.jackbird.player

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.plugin.JSArray
import java.util.concurrent.Executors
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** A song: the page's key for it, its media URL, and what the lock screen shows. */
@InvokeArg
class Song {
  lateinit var key: String
  lateinit var url: String
  var title: String? = null
  var artist: String? = null
  var album: String? = null
  /** The cover, as a data: URL. */
  var cover: String? = null
}

@InvokeArg
class QueueArgs {
  /** The song to play, then the ones ahead of it. */
  lateinit var songs: Array<Song>
  /** Where in the first song, in seconds, and whether it plays at once. */
  var at: Double = 0.0
  var play: Boolean = false
}

@InvokeArg
class UpcomingArgs {
  lateinit var songs: Array<Song>
}

@InvokeArg
class PickArgs {
  /** Where the picker opens (a folder's `content://` address), if anywhere in particular. */
  var initial: String? = null
  /**
   * Whether the app keeps the folder's permission across restarts (a folder opened as a root); not
   * for an upload, whose grant lasts while the app runs, so uploads do not pile up kept grants.
   */
  var keep: Boolean = true
}

@InvokeArg
class TreeArgs {
  lateinit var tree: String
}

@InvokeArg
class TreePathArgs {
  lateinit var tree: String
  var path: String = ""
}

@InvokeArg
class TreeWriteArgs {
  lateinit var tree: String
  var path: String = ""
  /** The bytes, in base64. */
  var data: String = ""
}

@InvokeArg
class TreeRenameArgs {
  lateinit var tree: String
  var from: String = ""
  var to: String = ""
}

@InvokeArg
class TreeUploadArgs {
  lateinit var tree: String
  var path: String = ""
  /** Where it goes: the service's `…/api/library/upload?path=…` address. */
  var url: String = ""
  /** The session's `Authorization` header, if there is one. */
  var authorization: String? = null
  /** Hears `{ sent }`, the bytes sent so far, as they go (now and then, not at every piece). */
  var progress: Channel? = null
}

@InvokeArg
class TreeOpenArgs {
  lateinit var tree: String
  var path: String = ""
  var write: Boolean = false
}

@InvokeArg
class OutputArgs {
  var bitPerfect: Boolean = false
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  /** The phone's folders (E6b-D9), worked on one call at a time off the main thread. */
  private val folders = Folders(activity.contentResolver)
  private val worker = Executors.newSingleThreadExecutor()
  /** Uploads, one at a time, on their own thread: a long one does not hold up the folders' work. */
  private val uploader = Executors.newSingleThreadExecutor()
  /** The spectrum's bins, off the main thread (see `spectrum`). */
  private val analyser = Executors.newSingleThreadExecutor()
  private var player: Player? = null

  /** The player's queue, where it was in it and at what time (ms): what a player made anew gets back. */
  private class Kept(val items: List<MediaItem>, val index: Int, val position: Long)

  /**
   * The queue as the player last had it. Paused, the service is no longer in the foreground, and
   * Android stops it a minute or so after the app leaves the screen: its player is released with its
   * queue, and the next play (the person back in the app) starts a service with an empty player,
   * which played nothing while the page thought it played (the owner's report, 2026-11-23). The
   * new player is given this queue back, paused where it was (`withPlayer`).
   */
  private var kept: Kept? = null

  private fun keep(player: Player) {
    kept = if (player.mediaItemCount == 0) null else Kept(
      (0 until player.mediaItemCount).map { player.getMediaItemAt(it) },
      player.currentMediaItemIndex,
      player.currentPosition
    )
  }

  private val listener = object : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      player?.let { keep(it) }
      send("state")
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      player?.let { keep(it) }
      send("state")
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      if (playbackState == Player.STATE_READY) send("state")
      if (playbackState == Player.STATE_ENDED) send("ended")
    }

    // The next song started: by itself, or from the notification's or the lock screen's ⏭.
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      player?.let { keep(it) }
      if (mediaItem != null && reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) send("advance")
    }

    // A song's tracks are known: its codec, depth and rate, for what sounds (E6b-D10).
    override fun onTracksChanged(tracks: Tracks) = sendSounding()

    override fun onPlayerError(error: PlaybackException) {
      val event = snapshot()
      event.put("message", "${error.errorCodeName}: ${error.message ?: ""}")
      trigger("failed", event)
    }
  }

  /** What plays: its key, whether it plays (and is meant to), where it is and how long it is (seconds). */
  private fun snapshot(): JSObject {
    val answer = JSObject()
    val player = player ?: return answer.apply {
      put("playing", false)
      put("playWhenReady", false)
      put("position", 0.0)
    }
    answer.put("key", player.currentMediaItem?.mediaId)
    answer.put("playing", player.isPlaying)
    // Whether it is meant to play (false once paused, from the page or the notification).
    answer.put("playWhenReady", player.playWhenReady)
    answer.put("position", player.currentPosition / 1000.0)
    val duration = player.duration
    if (duration > 0) answer.put("duration", duration / 1000.0)
    return answer
  }

  private fun send(event: String) = trigger(event, snapshot())

  /** The audio format of the song playing, as its track says. */
  private fun songFormat(): Format? =
    player?.currentTracks?.groups?.firstOrNull { it.type == C.TRACK_TYPE_AUDIO && it.isSelected }?.let { group ->
      (0 until group.length).firstOrNull { group.isTrackSelected(it) }?.let { group.getTrackFormat(it) }
    }

  /**
   * What sounds (E6b-D10), as the desktop's output says it (src/lib/native-audio.ts' `started`): the
   * song's codec, depth and rate, and its way to the device: bit-perfect, bit-perfect but for the
   * phone's volume (below its top, applied by the sink: Volume.kt), or through Android's mixer.
   */
  private fun sendSounding() {
    val player = player ?: return
    val key = player.currentMediaItem?.mediaId ?: return
    val format = songFormat() ?: return
    val way = BitPerfect.way
    val codec = when (format.sampleMimeType) {
      MimeTypes.AUDIO_FLAC -> "FLAC"
      MimeTypes.AUDIO_MPEG -> "MP3"
      MimeTypes.AUDIO_AAC -> "AAC"
      MimeTypes.AUDIO_OPUS -> "Opus"
      MimeTypes.AUDIO_VORBIS -> "Vorbis"
      MimeTypes.AUDIO_ALAC -> "ALAC"
      MimeTypes.AUDIO_RAW, MimeTypes.AUDIO_WAV -> "WAV"
      else -> format.sampleMimeType?.substringAfter('/')?.uppercase() ?: "?"
    }
    val bits = when (format.pcmEncoding) {
      C.ENCODING_PCM_16BIT -> 16
      C.ENCODING_PCM_24BIT -> 24
      C.ENCODING_PCM_32BIT, C.ENCODING_PCM_FLOAT -> 32
      C.ENCODING_PCM_8BIT -> 8
      else -> 0
    }
    val rate = if (format.sampleRate > 0) format.sampleRate else way?.rate ?: 0
    val event = JSObject()
    event.put("key", key)
    event.put("codec", codec)
    event.put("format", JSObject().apply {
      put("rate", rate)
      put("channels", format.channelCount)
      put("bits", bits)
    })
    event.put("route", JSObject().apply {
      put("device", way?.device ?: "Android")
      put("mode", if (way?.bitPerfect == true) "exclusive" else "shared")
      put("rate", way?.rate ?: rate)
      put("sample", way?.sample ?: "")
      put("fidelity", if (way?.bitPerfect != true) "mixer" else if (Volume.atTop) "bit-perfect" else "volume")
    })
    event.put("offered", way?.offered ?: "")
    trigger("sounding", event)
  }

  /**
   * The system's bars and the camera's cutout over the page, in CSS pixels (Android draws apps edge
   * to edge); and `keyboard`, how much of the page's bottom the on-screen keyboard covers (0 while
   * it is down).
   */
  @Volatile private var safe = JSObject().apply {
    put("top", 0.0)
    put("right", 0.0)
    put("bottom", 0.0)
    put("left", 0.0)
    put("keyboard", 0.0)
  }

  override fun load(webView: WebView) {
    super.load(webView)
    BitPerfect.listener = { main.post { sendSounding() } }
    // What covers the page's edges: the status bar, the camera's cutout, the navigation bar. The page
    // keeps clear of them (src/lib/safe-area.ts); the webview's own reading of them is not relied on.
    // And the keyboard: edge to edge, the webview keeps its size and the keyboard lies over it, so
    // the page is told how much of the webview it covers (none, if the window was made smaller).
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val edges = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val place = IntArray(2)
      view.getLocationInWindow(place)
      val covered = maxOf(0, place[1] + view.height - (view.rootView.height - ime))
      val density = view.resources.displayMetrics.density
      safe = JSObject().apply {
        put("top", edges.top / density)
        put("right", edges.right / density)
        put("bottom", edges.bottom / density)
        put("left", edges.left / density)
        put("keyboard", (if (ime > 0) covered else 0) / density)
      }
      trigger("insets", safe)
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /**
   * The spectrum of what plays (Spectrum.kt): bins as Web Audio's analyser gives them, and the rate.
   * Worked out on a thread of its own: a command runs on the main thread, which also draws the
   * page, and an 8192-sample FFT and its 4096 bins there, many times a second, held the drawing
   * back (and the answers with it); nor does it wait behind the folders' work (`worker`).
   */
  @Command
  fun spectrum(invoke: Invoke) {
    analyser.execute {
      try {
        val bins = Spectrum.bins()
        if (bins == null) {
          invoke.resolve(JSObject().apply { put("bins", null as String?) })
        } else {
          invoke.resolve(JSObject().apply {
            put("bins", JSArray().apply { bins.forEach { put(it) } })
            put("rate", Spectrum.rate)
          })
        }
      } catch (error: Exception) {
        invoke.reject(error.message ?: error.toString())
      }
    }
  }

  /** What covers the page's edges now (`insets` events follow each change). */
  @Command
  fun safeArea(invoke: Invoke) {
    invoke.resolve(safe)
  }

  // ─── The phone's folders (E6b-D9) ───────────────────────────────────────────

  /** Runs folder work off the main thread; an exception rejects the call with its message. */
  private fun work(invoke: Invoke, job: () -> Unit) = work(invoke, worker, job)

  private fun work(invoke: Invoke, thread: java.util.concurrent.Executor, job: () -> Unit) {
    thread.execute {
      try {
        job()
      } catch (error: Exception) {
        invoke.reject(error.message ?: error.toString(), if (error is java.io.FileNotFoundException) "missing" else "io")
      }
    }
  }

  private fun statJson(found: Found): JSObject = JSObject().apply {
    put("kind", if (found.folder) "directory" else "file")
    put("size", found.size)
    put("mtime", found.mtime)
  }

  private fun entryJson(found: Found): JSObject = JSObject().apply {
    put("name", found.name)
    put("path", found.path)
    put("kind", if (found.folder) "directory" else "file")
    put("stat", statJson(found))
  }

  /**
   * Android's folder picker: the person chooses a folder, and the app keeps the permission for that
   * folder alone (read and write), across restarts. `{ tree, name }`, or `{ tree: null }` when cancelled.
   */
  @Command
  fun pickFolder(invoke: Invoke) {
    val args = invoke.parseArgs(PickArgs::class.java)
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    )
    args.initial?.let { intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(it)) }
    startActivityForResult(invoke, intent, "folderPicked")
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val tree = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      invoke.resolve(JSObject().apply { put("tree", null as String?) })
      return
    }
    val keep = invoke.parseArgs(PickArgs::class.java).keep
    work(invoke) {
      if (keep) activity.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      invoke.resolve(JSObject().apply {
        put("tree", tree.toString())
        put("name", folders.name(tree))
      })
    }
  }

  /** A folder kept from before: its name while the permission lasts; refused once it is gone. */
  @Command
  fun folderCheck(invoke: Invoke) {
    val args = invoke.parseArgs(TreeArgs::class.java)
    work(invoke) {
      val tree = Uri.parse(args.tree)
      if (!folders.granted(tree)) throw java.io.FileNotFoundException("no permission for ${args.tree}")
      invoke.resolve(JSObject().apply { put("name", folders.name(tree)) })
    }
  }

  @Command
  fun folderWalk(invoke: Invoke) {
    val args = invoke.parseArgs(TreeArgs::class.java)
    work(invoke) {
      val files = JSArray()
      for (found in folders.walk(Uri.parse(args.tree))) files.put(JSObject().apply {
        put("path", found.path)
        put("stat", statJson(found))
      })
      invoke.resolve(JSObject().apply { put("files", files) })
    }
  }

  @Command
  fun folderList(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      val entries = JSArray()
      for (found in folders.list(Uri.parse(args.tree), args.path)) entries.put(entryJson(found))
      invoke.resolve(JSObject().apply { put("entries", entries) })
    }
  }

  @Command
  fun folderStat(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      val found = folders.stat(Uri.parse(args.tree), args.path)
      invoke.resolve(JSObject().apply { put("stat", found?.let { statJson(it) }) })
    }
  }

  @Command
  fun folderRead(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      val bytes = folders.read(Uri.parse(args.tree), args.path)
      invoke.resolve(JSObject().apply { put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)) })
    }
  }

  @Command
  fun folderWrite(invoke: Invoke) {
    val args = invoke.parseArgs(TreeWriteArgs::class.java)
    work(invoke) {
      folders.write(Uri.parse(args.tree), args.path, Base64.decode(args.data, Base64.DEFAULT))
      invoke.resolve()
    }
  }

  @Command
  fun folderDelete(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      folders.delete(Uri.parse(args.tree), args.path)
      invoke.resolve()
    }
  }

  @Command
  fun folderRename(invoke: Invoke) {
    val args = invoke.parseArgs(TreeRenameArgs::class.java)
    work(invoke) {
      folders.rename(Uri.parse(args.tree), args.from, args.to)
      invoke.resolve()
    }
  }

  @Command
  fun folderMkdir(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      folders.mkdir(Uri.parse(args.tree), args.path)
      invoke.resolve()
    }
  }

  /**
   * Sends one of the folder's files to the service (an upload to the family library): `POST`, its
   * bytes as they are read, never all at once in memory, with the session's `Authorization`; the
   * bytes sent told on `progress` as they go.
   * Resolves with the service's answer, whatever it is (`{ status, body }`); rejects when the
   * service could not be reached or the file not sent, so the page can try another address.
   */
  @Command
  fun folderUpload(invoke: Invoke) {
    val args = invoke.parseArgs(TreeUploadArgs::class.java)
    work(invoke, uploader) {
      val tree = Uri.parse(args.tree)
      val size = folders.stat(tree, args.path)?.size ?: throw java.io.FileNotFoundException(args.path)
      val connection = java.net.URL(args.url).openConnection() as java.net.HttpURLConnection
      try {
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = 5_000
        connection.readTimeout = 120_000
        connection.setRequestProperty("Content-Type", "application/octet-stream")
        args.authorization?.let { connection.setRequestProperty("Authorization", it) }
        // Its length when the provider knows it; in pieces when it does not.
        if (size > 0) connection.setFixedLengthStreamingMode(size) else connection.setChunkedStreamingMode(64 * 1024)
        folders.input(tree, args.path).use { input ->
          connection.outputStream.use { output ->
            // Told to the page every 256 KB or so and at the end, not at every 64 KB piece.
            val buffer = ByteArray(64 * 1024)
            var sent = 0L
            var told = 0L
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              sent += read
              if (sent - told >= 256 * 1024) {
                told = sent
                args.progress?.send(JSObject().apply { put("sent", sent) })
              }
            }
            output.flush()
            if (sent != told) args.progress?.send(JSObject().apply { put("sent", sent) })
          }
        }
        val status = connection.responseCode
        val body = (if (status >= 400) connection.errorStream else connection.inputStream)
          ?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        invoke.resolve(JSObject().apply {
          put("status", status)
          put("body", body)
        })
      } finally {
        connection.disconnect()
      }
    }
  }

  /**
   * The picture the clipboard holds (an image copied in another app: Android hands it over as a
   * `content://` address the app may read while it has the focus), for the picture crop's Paste key:
   * `{ type, data }` (base64), or nulls when it holds none. The webview itself has no clipboard to read.
   */
  @Command
  fun clipboardImage(invoke: Invoke) {
    work(invoke) {
      val clipboard = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
      val clip = clipboard.primaryClip
      var found: Pair<String, ByteArray>? = null
      if (clip != null) {
        val described = (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) }.firstOrNull { it.startsWith("image/") }
        for (index in 0 until clip.itemCount) {
          val uri = clip.getItemAt(index).uri ?: continue
          val type = activity.contentResolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: described ?: continue
          val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
          found = type to bytes
          break
        }
      }
      invoke.resolve(JSObject().apply {
        put("type", found?.first)
        put("data", found?.second?.let { Base64.encodeToString(it, Base64.NO_WRAP) })
      })
    }
  }

  /** A file's `content://` address, which the player plays. */
  @Command
  fun folderAddress(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      invoke.resolve(JSObject().apply { put("address", folders.address(Uri.parse(args.tree), args.path)) })
    }
  }

  /**
   * Opens a file for Rust's tag engine, and gives up the descriptor to it: Rust owns it and closes it.
   * Called by Rust alone (`tauri_plugin_jackbird_player::open_file`), never by the page: it is not
   * among the plugin's permissions, so a descriptor's number never comes from the page.
   */
  @Command
  fun folderDetach(invoke: Invoke) {
    val args = invoke.parseArgs(TreeOpenArgs::class.java)
    work(invoke) {
      invoke.resolve(JSObject().apply { put("fd", folders.detachFile(Uri.parse(args.tree), args.path, args.write)) })
    }
  }

  /**
   * A new file beside one of the folder's, for a save whose tags no longer fit (E6b-D9's second
   * part), opened for Rust and its descriptor given up: `{ path, fd }`. Rust alone calls it, as
   * `folderDetach`; it is not among the plugin's permissions.
   */
  @Command
  fun folderBeside(invoke: Invoke) {
    val args = invoke.parseArgs(TreePathArgs::class.java)
    work(invoke) {
      val (path, fd) = folders.detachBeside(Uri.parse(args.tree), args.path)
      invoke.resolve(JSObject().apply {
        put("path", path)
        put("fd", fd)
      })
    }
  }

  /** The file written beside one put in its place (`from` over `to`). Rust alone calls it, after checking the new file. */
  @Command
  fun folderReplace(invoke: Invoke) {
    val args = invoke.parseArgs(TreeRenameArgs::class.java)
    work(invoke) {
      folders.replace(Uri.parse(args.tree), args.from, args.to)
      invoke.resolve()
    }
  }

  /**
   * The person's output setting (E6b-D10): bit-perfect to a USB DAC, at once. The playing track's
   * AudioTrack keeps the mixer it was made with (and the player reuses it for songs of the same
   * format), so a seek makes a new one, for which BitPerfectSink asks again. Media3 ignores a seek
   * to the millisecond the player is at (always while paused): the seek goes one back (one forward
   * at the very start). Ended or idle, the next play makes a new AudioTrack anyway.
   */
  @Command
  fun setOutput(invoke: Invoke) {
    val args = invoke.parseArgs(OutputArgs::class.java)
    val changed = BitPerfect.wanted != args.bitPerfect
    BitPerfect.wanted = args.bitPerfect
    if (!changed || BitPerfect.lastFormat == null) {
      invoke.resolve()
      return
    }
    BitPerfect.pending = true
    withPlayer(invoke) { player ->
      val ready = player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING
      if (player.mediaItemCount > 0 && ready) {
        val at = player.currentPosition
        player.seekTo(if (at > 0) at - 1 else 1)
      }
      invoke.resolve()
    }
  }

  /** Whether this Android can play bit-perfect to a USB DAC (14 and later), and the DAC connected, if any. */
  @Command
  fun outputInfo(invoke: Invoke) {
    invoke.resolve(JSObject().apply {
      put("bitPerfect", BitPerfect.possible)
      put("usb", BitPerfect.usbDevice(activity)?.productName?.toString())
    })
  }

  /**
   * Runs `work` with the player on the main thread, the player's own; an exception rejects the call,
   * as does a service that could not start (the call never waits for ever: the page's calls go one
   * after the other, and one left waiting would hold up every one after it). A player made anew
   * (the service stopped and started again) gets the queue back first, paused where it was.
   */
  private fun withPlayer(invoke: Invoke, work: (Player) -> Unit) {
    main.post {
      PlayerService.withPlayer(activity, { found ->
        try {
          if (player !== found) {
            player?.removeListener(listener)
            val back = kept
            if (found.mediaItemCount == 0 && back != null) {
              found.setMediaItems(back.items, back.index.coerceIn(0, back.items.size - 1), back.position)
              found.playWhenReady = false
              found.prepare()
            }
            found.addListener(listener)
            player = found
          }
          work(found)
        } catch (error: Exception) {
          invoke.reject(error.message ?: error.toString())
        }
      }, { error -> invoke.reject(error.message ?: error.toString()) })
    }
  }

  private fun itemOf(song: Song): MediaItem {
    val metadata = MediaMetadata.Builder().setTitle(song.title).setArtist(song.artist).setAlbumTitle(song.album)
    song.cover?.substringAfter("base64,", "")?.takeIf { it.isNotEmpty() }?.let { data ->
      try {
        metadata.setArtworkData(Base64.decode(data, Base64.DEFAULT), MediaMetadata.PICTURE_TYPE_FRONT_COVER)
      } catch (_: IllegalArgumentException) {
        // Not base64: no cover.
      }
    }
    return MediaItem.Builder().setMediaId(song.key).setUri(song.url).setMediaMetadata(metadata.build()).build()
  }

  /** The queue anew: the first song loaded at `at`, playing or not, and the ones ahead of it. */
  @Command
  fun setQueue(invoke: Invoke) {
    val args = invoke.parseArgs(QueueArgs::class.java)
    withPlayer(invoke) { player ->
      player.setMediaItems(args.songs.map(::itemOf), 0, (args.at * 1000).toLong())
      player.playWhenReady = args.play
      player.prepare()
      keep(player)
      invoke.resolve()
    }
  }

  /** The songs after the one playing, in place of those it had; the one playing goes on. */
  @Command
  fun setUpcoming(invoke: Invoke) {
    val args = invoke.parseArgs(UpcomingArgs::class.java)
    withPlayer(invoke) { player ->
      val at = player.currentMediaItemIndex
      if (player.mediaItemCount > at + 1) player.removeMediaItems(at + 1, player.mediaItemCount)
      // The songs before it are done with: the one playing becomes the first.
      if (at > 0) player.removeMediaItems(0, at)
      player.addMediaItems(args.songs.map(::itemOf))
      keep(player)
      invoke.resolve()
    }
  }

  @Command
  fun play(invoke: Invoke) {
    withPlayer(invoke) { player ->
      if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
      if (player.playbackState == Player.STATE_IDLE) player.prepare()
      player.play()
      invoke.resolve()
    }
  }

  @Command
  fun pause(invoke: Invoke) {
    withPlayer(invoke) { player ->
      player.pause()
      keep(player)
      invoke.resolve()
    }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    withPlayer(invoke) { player ->
      player.seekTo((args.seconds * 1000).toLong())
      keep(player)
      invoke.resolve()
    }
  }

  /** Stops and empties the queue: the notification goes, and the service may end. */
  @Command
  fun stop(invoke: Invoke) {
    withPlayer(invoke) { player ->
      player.stop()
      player.clearMediaItems()
      kept = null
      invoke.resolve()
    }
  }

  @Command
  fun status(invoke: Invoke) {
    withPlayer(invoke) { invoke.resolve(snapshot()) }
  }

}
