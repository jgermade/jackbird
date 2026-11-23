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
    val player = ExoPlayer.Builder(this, renderers)
      // Music: it takes the audio focus (and gives it back to a call). A headset unplugged pauses it:
      // by `noisy` below, not Media3's own, so a USB DAC that only blinks goes on.
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        true
      )
      .setHandleAudioBecomingNoisy(false)
      // The songs come from the instance: the Wi-Fi is kept awake with the CPU while it plays.
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
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
    player.addListener(object : Player.Listener {
      // Played again by the person (or anything else) meanwhile: the noise's pause is no longer ours to undo.
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (playWhenReady) pausedByNoise = false
      }
    })
    // A system broadcast: received though the receiver is not exported.
    ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    current = made.player
    val ready = waiting.toList()
    waiting.clear()
    failing.clear()
    ready.forEach { it(made.player) }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  private val main = Handler(Looper.getMainLooper())

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
    super.onDestroy()
  }

  companion object {
    private const val TAG = "jackbird"

    /** How often the DAC is looked for after the noise's pause (ms), and how many times. */
    private const val RESUME_EVERY = 1000L
    private const val RESUME_LOOKS = 5

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
