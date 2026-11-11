// The phone's player (E6b, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-11): one
// ExoPlayer in a MediaSessionService. Media3 makes it a foreground service while it plays, with a
// notification that carries the controls, and gives the lock screen and a headset's buttons the
// same session; so the queue plays on with the app in the background, which the page's <audio>
// could not (E6-D1 c). PlayerPlugin drives the player directly, in this same process.

package es.germade.jackbird.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlayerService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    // Decoded to float (24-bit songs keep their depth), through a sink that prepares Android's mixer
    // for bit-perfect output to a USB DAC when the person wants it (E6b-D10, BitPerfect.kt).
    val context = this
    val renderers = object : DefaultRenderersFactory(context) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        BitPerfectSink(context, DefaultAudioSink.Builder(context).setEnableFloatOutput(true).build())
    }
    val player = ExoPlayer.Builder(this, renderers)
      // Music: it takes the audio focus (and gives it back to a call), and pauses when a headset is
      // unplugged.
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        true
      )
      .setHandleAudioBecomingNoisy(true)
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
    current = made.player
    waiting.forEach { it(made.player) }
    waiting.clear()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  // The app swiped away: the music goes on if it plays, else the service ends with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = session?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    session?.run {
      player.release()
      release()
    }
    session = null
    current = null
    super.onDestroy()
  }

  companion object {
    private var current: Player? = null
    private val waiting = mutableListOf<(Player) -> Unit>()

    /** Runs `work` with the player, starting the service first if it is not running. On the main thread. */
    fun withPlayer(context: Context, work: (Player) -> Unit) {
      val player = current
      if (player != null) {
        work(player)
        return
      }
      waiting.add(work)
      if (waiting.size == 1) context.startService(Intent(context, PlayerService::class.java))
    }
  }
}
