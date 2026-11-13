// Bit-perfect output to a USB DAC (E6b-D10, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
// 2026-11-11 23:29). Android mixes every app's sound at its own rate; from Android 14 an app may ask
// that, for media on a USB device, the mixer pass its samples through untouched, at a format the
// device offers (AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT). The player's audio sink calls
// `prepare` with the exact PCM format of each AudioTrack before it is made: a matching format is
// set, or the preference is cleared, and the way the song goes is reported.

package es.germade.jackbird.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioMixerAttributes
import android.os.Build
import android.util.Log
import androidx.media3.common.Format
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import java.nio.ByteBuffer

/** How a song goes to the device: its name, bit-perfect or not, at what rate and sample, and what the device offers. */
data class Way(val device: String, val bitPerfect: Boolean, val rate: Int, val sample: String, val offered: String)

object BitPerfect {
  /** The person's setting ("Bit-perfect to a USB DAC"); off by default. */
  @Volatile var wanted = false

  /**
   * The setting changed since the playing track's AudioTrack was made: the sink asks again when the
   * player flushes it (PlayerPlugin.setOutput seeks to where it is, which makes a new AudioTrack).
   */
  @Volatile var pending = false

  /** The format of the AudioTrack last made, to ask for again. */
  @Volatile var lastFormat: Format? = null

  /** The way the last AudioTrack was made, and who hears it (PlayerPlugin). */
  @Volatile var way: Way? = null
  @Volatile var listener: ((Way) -> Unit)? = null

  /** Whether this Android can do it at all. */
  val possible: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

  /** The media attributes the player plays with, as Android's. */
  val attributes: AudioAttributes =
    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()

  /** The USB device connected for output, if any. */
  fun usbDevice(context: Context): AudioDeviceInfo? {
    val manager = context.getSystemService(AudioManager::class.java) ?: return null
    return manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
      it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
    }
  }

  private fun sampleName(encoding: Int): String = when (encoding) {
    AudioFormat.ENCODING_PCM_16BIT -> "16-bit"
    AudioFormat.ENCODING_PCM_24BIT_PACKED -> "24-bit"
    AudioFormat.ENCODING_PCM_32BIT -> "32-bit"
    AudioFormat.ENCODING_PCM_FLOAT -> "float"
    AudioFormat.ENCODING_PCM_8BIT -> "8-bit"
    else -> "encoding $encoding"
  }

  /**
   * The mixer format for a track of `rate`, `channels` and `encoding` among those a device offers
   * bit-perfect (format, behaviour): the same three, or none.
   */
  fun choose(offered: List<Triple<Int, Int, Int>>, rate: Int, channels: Int, encoding: Int): Int? =
    offered.indexOfFirst { (offeredRate, offeredChannels, offeredEncoding) ->
      offeredRate == rate && offeredChannels == channels && offeredEncoding == encoding
    }.takeIf { it >= 0 }

  /** Sets (or clears) the mixer's format for a track about to be made, and reports the way. */
  fun prepare(context: Context, format: Format) {
    lastFormat = format
    pending = false
    val manager = context.getSystemService(AudioManager::class.java) ?: return
    val usb = usbDevice(context)
    val encoding = if (format.pcmEncoding == Format.NO_VALUE) AudioFormat.ENCODING_PCM_16BIT else format.pcmEncoding
    val sample = sampleName(encoding)
    val device = usb?.productName?.toString() ?: "Android"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || usb == null) {
      report(Way(device, false, format.sampleRate, sample, ""))
      return
    }
    val all = manager.getSupportedMixerAttributes(usb).filter { it.mixerBehavior == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT }
    val offered = all.map { Triple(it.format.sampleRate, it.format.channelCount, it.format.encoding) }
    val described = offered.map { (rate, _, enc) -> "${sampleName(enc)}/${rate / 1000.0}" }.distinct().joinToString(", ")
    val found = if (wanted) choose(offered, format.sampleRate, format.channelCount, encoding) else null
    if (wanted && found == null) {
      Log.i(TAG, "bit-perfect: the DAC offers no ${sample}/${format.sampleRate}/${format.channelCount}ch (it offers $described)")
    }
    if (found != null && manager.setPreferredMixerAttributes(attributes, usb, all[found])) {
      report(Way(device, true, format.sampleRate, sample, described))
    } else {
      if (found != null) Log.w(TAG, "bit-perfect: Android refused the mixer's format ${all[found]}")
      manager.clearPreferredMixerAttributes(attributes, usb)
      report(Way(device, false, format.sampleRate, sample, described))
    }
  }

  private const val TAG = "jackbird"

  private fun report(way: Way) {
    this.way = way
    listener?.invoke(way)
  }
}

/**
 * The player's audio sink, which prepares the mixer for each AudioTrack before it is made, and lets
 * the spectrum (Spectrum.kt) read the PCM it takes, unchanged.
 */
class BitPerfectSink(private val context: Context, sink: AudioSink) : ForwardingAudioSink(sink) {
  override fun configure(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
    prepareSafely(inputFormat)
    Spectrum.configure(inputFormat.pcmEncoding, inputFormat.channelCount, inputFormat.sampleRate)
    super.configure(inputFormat, specifiedBufferSize, outputChannels)
  }

  // The bytes the sink consumed this time (it may take a buffer in several calls) go to the
  // spectrum, read through a copy of the buffer's position: what is played is not touched.
  override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    val from = buffer.position()
    val done = super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
    try {
      Spectrum.feed(buffer, from, buffer.position())
    } catch (error: Exception) {
      // The spectrum is decoration: a buffer it cannot read leaves it as it was.
    }
    return done
  }

  // A flush lets the AudioTrack go, and the next one is made with the mixer as it then is: the
  // setting, changed while a song plays, is asked for again here (BitPerfect.pending).
  override fun flush() {
    Spectrum.clear()
    val format = BitPerfect.lastFormat
    if (BitPerfect.pending && format != null) prepareSafely(format)
    super.flush()
  }

  private fun prepareSafely(format: Format) {
    try {
      BitPerfect.prepare(context, format)
    } catch (error: Exception) {
      // The mixer's preference is a nicety: the song plays through Android's mixer.
      Log.w("jackbird", "bit-perfect: could not set the mixer's format", error)
    }
  }
}
