// The phone's player (E6b, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-11): one
// ExoPlayer in a MediaSessionService. Media3 makes it a foreground service while it plays, with a
// notification that carries the controls, and gives the lock screen and a headset's buttons the
// same session; so the queue plays on with the app in the background, which the page's <audio>
// could not (E6-D1 c). PlayerPlugin drives the player directly, in this same process.

package es.germade.jackbird.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import android.os.Handler
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.FormatHolder
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlayerService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val player = buildPlayer()
    val builder = MediaSession.Builder(this, player)
    // The notification opens the app.
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setSessionActivity(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE))
    }
    val made = builder.build()
    // Added by hand: Media3 adds a session when a MediaController asks for it, and PlayerPlugin uses
    // the player directly. Only an added session gets the notification, and with it the foreground
    // service; without one Android stops the service a minute after the app leaves the screen.
    addSession(made)
    session = made
    player.addListener(watcher)
    // A system broadcast: received though the receiver is not exported.
    ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    current = made.player
    service = this
    if (crossfadeMs > 0) main.post(fading)
    val ready = waiting.toList()
    waiting.clear()
    failing.clear()
    ready.forEach { it(made.player) }
  }

  /** A player: the session's, or the one a crossfade fades in. */
  private fun buildPlayer(): ExoPlayer {
    // Decoded to float (24-bit songs keep their depth), through a sink that prepares Android's mixer
    // for bit-perfect output to a USB DAC when the person wants it, and writes integers to a DAC
    // that takes only those (E6b-D10, BitPerfect.kt). The renderer tells it each song's own depth.
    val context = this
    val renderers = object : DefaultRenderersFactory(context) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink {
        var sink: BitPerfectSink? = null
        val tracks = IntegerTracks { sink?.output ?: Output.FLOAT }
        val made = BitPerfectSink(context, DefaultAudioSink.Builder(context).setEnableFloatOutput(true).setAudioTrackProvider(tracks).build())
        sink = made
        return made
      }

      override fun buildAudioRenderers(
        context: Context,
        extensionRendererMode: Int,
        mediaCodecSelector: MediaCodecSelector,
        enableDecoderFallback: Boolean,
        audioSink: AudioSink,
        eventHandler: Handler,
        eventListener: AudioRendererEventListener,
        out: ArrayList<Renderer>
      ) {
        val adapters = getCodecAdapterFactory()
        out.add(object : MediaCodecAudioRenderer(context, adapters, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, audioSink) {
          // The song's own sample, as its file says (a FLAC's depth), before its decoded samples
          // reach the sink.
          override fun onInputFormatChanged(formatHolder: FormatHolder): DecoderReuseEvaluation? {
            BitPerfect.sourceEncoding = formatHolder.format?.pcmEncoding ?: Format.NO_VALUE
            return super.onInputFormatChanged(formatHolder)
          }
        })
      }
    }
    return ExoPlayer.Builder(this, renderers)
      // Music: it takes the audio focus (and gives it back to a call). A headset unplugged pauses it:
      // by `noisy` below, not Media3's own, so a USB DAC that only blinks goes on.
      .setAudioAttributes(MUSIC, true)
      .setHandleAudioBecomingNoisy(false)
      // The songs come from the instance: the Wi-Fi is kept awake with the CPU while it plays.
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  private val main = Handler(Looper.getMainLooper())

  /** What the service hears of the session's player. */
  private val watcher = object : Player.Listener {
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      // Played again by the person (or anything else) meanwhile: the noise's pause is no longer ours to undo.
      if (playWhenReady) pausedByNoise = false
      // Paused or played during a crossfade: the song ending with it.
      ending?.playWhenReady = playWhenReady
    }

    // A seek, another queue or a stop during a crossfade ends it: the song ending goes at once.
    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
      if (reason == Player.DISCONTINUITY_REASON_SEEK) endFade()
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) endFade()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      if (playbackState == Player.STATE_IDLE) endFade()
    }
  }

  // ─── The crossfade (2026-11-23) ─────────────────────────────────────────────
  //
  // Media3's player plays one song at a time. A crossfade fades a second player in: some seconds
  // before the song's end, a new player is given the songs after it and starts, silent, and the
  // session (the notification, the lock screen) and the page move on to it; their volumes cross
  // (equal power) while the first plays its last seconds, and the first is then let go. Not with
  // "Bit-perfect to a USB DAC": its sink cannot mix two players.

  /** The player fading out, while the session's fades in. */
  private var ending: ExoPlayer? = null
  /** How long the crossfade under way lasts, in ms. */
  private var overlap = 0L

  private val fading = object : Runnable {
    override fun run() {
      tick()
      if (crossfadeMs > 0 || ending != null) main.postDelayed(this, if (ending != null) FADE_STEP else WATCH_STEP)
    }
  }

  private fun tick() {
    val player = session?.player as? ExoPlayer ?: return
    val out = ending
    if (out != null) {
      val progress = if (overlap > 0) player.currentPosition.toDouble() / overlap else 1.0
      val at = progress.coerceIn(0.0, 1.0) * Math.PI / 2
      player.volume = Math.sin(at).toFloat()
      out.volume = Math.cos(at).toFloat()
      if (progress >= 1.0 || out.playbackState == Player.STATE_ENDED) endFade()
      return
    }
    if (crossfadeMs <= 0 || BitPerfect.wanted || !player.isPlaying || !player.hasNextMediaItem()) return
    val duration = player.duration
    if (duration == C.TIME_UNSET || duration <= 0) return
    val length = minOf(crossfadeMs, duration / 2)
    if (duration - player.currentPosition > length) return
    startFade(player, length)
  }

  private fun startFade(player: ExoPlayer, length: Long) {
    val made = session ?: return
    val next = buildPlayer()
    val after = player.nextMediaItemIndex
    next.setMediaItems((after until player.mediaItemCount).map { player.getMediaItemAt(it) }, 0, 0L)
    next.volume = 0f
    next.prepare()
    // The song ending plays only its own last seconds, and gives up the audio focus to the next one.
    if (player.mediaItemCount > after) player.removeMediaItems(after, player.mediaItemCount)
    player.setAudioAttributes(MUSIC, false)
    player.removeListener(watcher)
    ending = player
    overlap = length
    next.addListener(watcher)
    made.player = next
    current = next
    next.play()
    Log.i(TAG, "crossfade: ${length} ms into ${next.currentMediaItem?.mediaId}")
    switched?.invoke(next)
    main.removeCallbacks(fading)
    main.post(fading)
  }

  /** The crossfade ends: the song fading out is let go, the one fading in at its full volume. */
  private fun endFade() {
    val out = ending ?: return
    ending = null
    out.stop()
    out.release()
    session?.player?.volume = 1f
  }

  /** Paused by Android's "becoming noisy", and not played again since: `noisy` may play it again. */
  private var pausedByNoise = false

  /** Looks for the USB DAC again after the noise's pause, every second for a few: there, it plays on. */
  private var looks = 0
  private val resume = object : Runnable {
    override fun run() {
      val player = session?.player ?: return
      if (!pausedByNoise) {
        Log.i(TAG, "becoming noisy: played or paused since, left as it is")
        return
      }
      val back = BitPerfect.usbDevice(this@PlayerService)
      if (back != null) {
        Log.i(TAG, "becoming noisy: ${back.productName} is there, playing on")
        pausedByNoise = false
        player.play()
      } else if (++looks < RESUME_LOOKS) {
        main.postDelayed(this, RESUME_EVERY)
      } else {
        Log.i(TAG, "becoming noisy: no USB DAC, it stays paused")
        pausedByNoise = false
      }
    }
  }

  /**
   * Android says the sound is about to come out of the phone's speaker (a headset unplugged, a USB
   * DAC gone): it pauses at once, as Media3's own handling did. A USB DAC may only have blinked:
   * some phones reset USB audio as the screen goes off (the owner's report: a HiBy FC3 and a
   * NICEHCK NK1 MAX paused with the screen). If one is there again within a few seconds, it plays on.
   */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
      val player = session?.player ?: return
      if (!player.playWhenReady) return
      val usb = BitPerfect.usbDevice(context)
      player.pause()
      pausedByNoise = true
      looks = 0
      Log.i(TAG, "becoming noisy: paused (a USB DAC ${if (usb != null) "still listed: ${usb.productName}" else "not listed"})")
      main.removeCallbacks(resume)
      main.postDelayed(resume, RESUME_EVERY)
    }
  }

  // The app swiped away: the music goes on if it plays, else the service ends with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = session?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    main.removeCallbacks(resume)
    main.removeCallbacks(fading)
    endFade()
    try {
      unregisterReceiver(noisy)
    } catch (error: IllegalArgumentException) {
      // Not registered: the session was never made.
    }
    session?.run {
      player.release()
      release()
    }
    session = null
    current = null
    service = null
    super.onDestroy()
  }

  companion object {
    private const val TAG = "jackbird"

    /** How often the DAC is looked for after the noise's pause (ms), and how many times. */
    private const val RESUME_EVERY = 1000L
    private const val RESUME_LOOKS = 5

    /** How often the end of a song is watched for a crossfade, and how often its volumes move (ms). */
    private const val WATCH_STEP = 200L
    private const val FADE_STEP = 40L

    /** Music: it takes the audio focus (and gives it back to a call). */
    private val MUSIC: AudioAttributes =
      AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()

    private var service: PlayerService? = null

    /** The crossfade's length in ms (0: none), as the page last said. */
    var crossfadeMs = 0L
      set(value) {
        field = value
        service?.let { running ->
          running.main.removeCallbacks(running.fading)
          if (value > 0) running.main.post(running.fading)
        }
      }

    /** Told when a crossfade moves the session to another player (PlayerPlugin follows it). */
    var switched: ((Player) -> Unit)? = null

    private var current: Player? = null
    private val waiting = mutableListOf<(Player) -> Unit>()
    private val failing = mutableListOf<(Exception) -> Unit>()

    /**
     * Runs `work` with the player, starting the service first if it is not running (Android stops
     * it a minute or so after the app leaves the screen with the music paused, and its player goes
     * with it). On the main thread. When the service cannot be started (Android refuses it to an
     * app in the background), `failed` is told, and so is every call waiting for it: none waits for
     * ever, and the next call tries again.
     */
    fun withPlayer(context: Context, work: (Player) -> Unit, failed: (Exception) -> Unit) {
      val player = current
      if (player != null) {
        work(player)
        return
      }
      waiting.add(work)
      failing.add(failed)
      if (waiting.size > 1) return
      try {
        context.startService(Intent(context, PlayerService::class.java))
      } catch (error: Exception) {
        Log.w(TAG, "the player's service could not start: ${error.message}")
        val told = failing.toList()
        waiting.clear()
        failing.clear()
        told.forEach { it(error) }
      }
    }
  }
}
