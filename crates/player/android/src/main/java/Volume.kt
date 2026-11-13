// The phone's volume while a song goes bit-perfect (E6b-D10; RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
// 2026-11-13 08:55). Android's mixer then applies no volume and leaves it to the DAC, and a DAC on
// a phone seldom has one that Android drives: the music played at full scale whatever the phone's
// volume (the owner's report: a FiiO KA11 on a Pixel 10). The sink (BitPerfectSink) applies it
// instead, as the gain Android's own curve gives the media volume's step on that device. At the top
// step the gain is exactly 1, and the samples go untouched.

package es.germade.jackbird.player

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

object Volume {
  /** The gain the sink applies to a bit-perfect track: 1 at the top of the phone's media volume, 0 muted. */
  @Volatile var gain = 1f
    private set

  /** Whether the samples go untouched (the volume at its top). */
  val atTop: Boolean get() = gain == 1f

  /** How often the volume is read while a song goes bit-perfect, in milliseconds. */
  private const val EVERY = 200L

  /** The range Android's curve is replaced by when it cannot be read for the device, in dB. */
  private const val RANGE_DB = 60f

  private const val TAG = "jackbird"

  private val main = Handler(Looper.getMainLooper())
  private var manager: AudioManager? = null
  private var deviceType = AudioDeviceInfo.TYPE_USB_HEADSET
  private var index = -1
  private var muted = false

  private val poll = object : Runnable {
    override fun run() {
      read()
      main.postDelayed(this, EVERY)
    }
  }

  /**
   * Follows the media volume for `device` from now on, read at once: the track about to be made
   * never starts at full scale. From the player's thread (BitPerfect.prepare).
   */
  fun follow(context: Context, device: AudioDeviceInfo) {
    val found = context.getSystemService(AudioManager::class.java) ?: return
    synchronized(this) {
      manager = found
      deviceType = device.type
      index = -1
    }
    read()
    main.removeCallbacks(poll)
    main.postDelayed(poll, EVERY)
  }

  /** Stops following it: the song goes through Android's mixer, which applies the volume itself. */
  fun stop() {
    main.removeCallbacks(poll)
    synchronized(this) {
      manager = null
      index = -1
      gain = 1f
    }
  }

  /** Reads the media volume; a change of the step sets the gain, and crossing the top is reported. */
  private fun read() {
    val wasTop: Boolean
    synchronized(this) {
      val manager = manager ?: return
      val step = manager.getStreamVolume(AudioManager.STREAM_MUSIC)
      val silent = manager.isStreamMute(AudioManager.STREAM_MUSIC)
      if (step == index && silent == muted) return
      index = step
      muted = silent
      wasTop = atTop
      val top = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
      gain = when {
        silent || step <= 0 -> 0f
        step >= top -> 1f
        else -> gainOf(decibels(manager, step, top))
      }
      Log.i(TAG, "bit-perfect: the phone's volume at $step of $top${if (silent) ", muted" else ""}: gain $gain")
    }
    if (wasTop != atTop) BitPerfect.way?.let { way -> BitPerfect.listener?.invoke(way) }
  }

  /** The step's level on the device as Android's curve gives it; a curve of RANGE_DB if it cannot. */
  private fun decibels(manager: AudioManager, step: Int, top: Int): Float {
    val curve = RANGE_DB * (step.toFloat() / top - 1f)
    // Bit-perfect needs Android 14; the curve's reading, 9.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return curve
    return try {
      manager.getStreamVolumeDb(AudioManager.STREAM_MUSIC, step, deviceType)
    } catch (error: IllegalArgumentException) {
      curve
    }
  }

  /** A level in dB as a gain, within 0 and 1 (0 for silence, or a level that is not a number). */
  fun gainOf(decibels: Float): Float {
    if (decibels.isNaN() || decibels == Float.NEGATIVE_INFINITY) return 0f
    return Math.pow(10.0, decibels / 20.0).toFloat().coerceIn(0f, 1f)
  }
}
