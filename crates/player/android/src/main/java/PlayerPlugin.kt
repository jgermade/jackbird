// The page's side of the phone's player (E6b): Tauri's plugin, whose commands the page calls
// (src/lib/phone-audio.ts) and whose events it hears. It hands PlayerService's player the song to
// play and the songs ahead of it, all at once, since the page may not be able to ask the instance
// for the next one in the background (E6-D1 c); the player goes through them by itself and says so.

package es.germade.jackbird.player

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.provider.Settings
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
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
  private var player: Player? = null

  private val listener = object : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) = send("state")

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = send("state")

    override fun onPlaybackStateChanged(playbackState: Int) {
      if (playbackState == Player.STATE_READY) send("state")
      if (playbackState == Player.STATE_ENDED) send("ended")
    }

    // The next song started: by itself, or from the notification's or the lock screen's ⏭.
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
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
   * song's codec, depth and rate, and its way to the device, bit-perfect or through Android's mixer.
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
      put("fidelity", if (way?.bitPerfect == true) "bit-perfect" else "mixer")
    })
    event.put("offered", way?.offered ?: "")
    trigger("sounding", event)
  }

  override fun load(webView: WebView) {
    super.load(webView)
    BitPerfect.listener = { main.post { sendSounding() } }
  }

  /** The person's output setting (E6b-D10): bit-perfect to a USB DAC, from the next song. */
  @Command
  fun setOutput(invoke: Invoke) {
    val args = invoke.parseArgs(OutputArgs::class.java)
    BitPerfect.wanted = args.bitPerfect
    invoke.resolve()
  }

  /** Whether this Android can play bit-perfect to a USB DAC (14 and later), and the DAC connected, if any. */
  @Command
  fun outputInfo(invoke: Invoke) {
    invoke.resolve(JSObject().apply {
      put("bitPerfect", BitPerfect.possible)
      put("usb", BitPerfect.usbDevice(activity)?.productName?.toString())
    })
  }

  /** Runs `work` with the player on the main thread, the player's own; an exception rejects the call. */
  private fun withPlayer(invoke: Invoke, work: (Player) -> Unit) {
    main.post {
      PlayerService.withPlayer(activity) { found ->
        if (player !== found) {
          player?.removeListener(listener)
          found.addListener(listener)
          player = found
        }
        try {
          work(found)
        } catch (error: Exception) {
          invoke.reject(error.message ?: error.toString())
        }
      }
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
      invoke.resolve()
    }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    withPlayer(invoke) { player ->
      player.seekTo((args.seconds * 1000).toLong())
      invoke.resolve()
    }
  }

  /** Stops and empties the queue: the notification goes, and the service may end. */
  @Command
  fun stop(invoke: Invoke) {
    withPlayer(invoke) { player ->
      player.stop()
      player.clearMediaItems()
      invoke.resolve()
    }
  }

  @Command
  fun status(invoke: Invoke) {
    withPlayer(invoke) { invoke.resolve(snapshot()) }
  }

  /** Whether the app may read and write the phone's shared storage (E6b-D9): "All files access" from Android 11. */
  private fun storageGranted(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
    else activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

  @Command
  fun storageAccess(invoke: Invoke) {
    invoke.resolve(JSObject().apply { put("granted", storageGranted()) })
  }

  /**
   * Asks for it: Android's own page for "All files access" (Android 11 and later), or the storage
   * permission's dialog before. Resolves at once; the page asks again when the app is back in front.
   */
  @Command
  fun askStorageAccess(invoke: Invoke) {
    main.post {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
          try {
            activity.startActivity(intent)
          } catch (_: Exception) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          }
        } else {
          activity.requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 4646)
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: error.toString())
      }
    }
  }
}
