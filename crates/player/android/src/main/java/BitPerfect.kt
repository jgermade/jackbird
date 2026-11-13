// Bit-perfect output to a USB DAC (E6b-D10, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
// 2026-11-11 23:29). Android mixes every app's sound at its own rate; from Android 14 an app may ask
// that, for media on a USB device, the mixer pass its samples through untouched, at a format the
// device offers (AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT). The player's audio sink calls
// `prepare` with the exact PCM format of each AudioTrack before it is made: a matching format is
// set, or the preference is cleared, and the way the song goes is reported.
//
// The player decodes to float. A DAC that offers float takes it as it is; one that offers only
// integers (E6b-D10's risk, the FiiO KA11) gets them from the sink (`Output`): 32-bit, which holds a
// 16- or 24-bit song's samples exactly, or 16-bit for a song of 16 bits or less. Media3's sink only
// writes 16-bit integers or float, so a 32-bit track is made by the AudioTrack provider
// (`IntegerTracks`) and handed the converted samples where it expects float (both 4 bytes a sample).

package es.germade.jackbird.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioMixerAttributes
import android.os.Build
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.DefaultAudioTrackProvider
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** How a song goes to the device: its name, bit-perfect or not, at what rate and sample, and what the device offers. */
data class Way(val device: String, val bitPerfect: Boolean, val rate: Int, val sample: String, val offered: String)

/** What the sink writes to the AudioTrack: the decoder's float, or integers for a DAC that takes only those. */
enum class Output { FLOAT, INT16, INT32 }

object BitPerfect {
  /** The person's setting ("Bit-perfect to a USB DAC"); off by default. */
  @Volatile var wanted = false

  /**
   * The setting changed since the playing track's AudioTrack was made: the sink asks again when the
   * player flushes it (PlayerPlugin.setOutput seeks to where it is, which makes a new AudioTrack).
   */
  @Volatile var pending = false

  /** What the next AudioTrack is written as, chosen by `prepare` (the sink reads it as it configures). */
  @Volatile var output = Output.FLOAT

  /**
   * The song's own sample, as its file says (a FLAC's depth: C.ENCODING_PCM_16BIT, _24BIT…), from
   * the renderer (PlayerService); Format.NO_VALUE for a lossy song.
   */
  @Volatile var sourceEncoding: Int = Format.NO_VALUE

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

  /** A song's depth in bits from its own sample; 16 for a lossy one (its decoder's usual depth). */
  fun depthOf(encoding: Int): Int = when (encoding) {
    C.ENCODING_PCM_8BIT -> 8
    C.ENCODING_PCM_24BIT -> 24
    C.ENCODING_PCM_32BIT, C.ENCODING_PCM_FLOAT -> 32
    else -> 16
  }

  /**
   * For a song decoded to `decoded` (float, or the integers a lossless song gives as they are) of
   * `depth` bits: the mixer format among those offered bit-perfect, and what the sink writes. Its
   * own encoding first; for float, then 32-bit integers (exact for up to 24 bits), then 16-bit for a
   * song of no more than 16. None: through Android's mixer.
   */
  fun pick(offered: List<Triple<Int, Int, Int>>, rate: Int, channels: Int, decoded: Int, depth: Int): Pair<Int, Output>? {
    choose(offered, rate, channels, decoded)?.let { return it to Output.FLOAT }
    if (decoded != AudioFormat.ENCODING_PCM_FLOAT) return null
    if (depth <= 24) choose(offered, rate, channels, AudioFormat.ENCODING_PCM_32BIT)?.let { return it to Output.INT32 }
    if (depth <= 16) choose(offered, rate, channels, AudioFormat.ENCODING_PCM_16BIT)?.let { return it to Output.INT16 }
    return null
  }

  /** Sets (or clears) the mixer's format for a track about to be made, and reports the way. */
  fun prepare(context: Context, format: Format) {
    lastFormat = format
    pending = false
    output = Output.FLOAT
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
    val depth = depthOf(sourceEncoding)
    val picked = if (wanted) pick(offered, format.sampleRate, format.channelCount, encoding, depth) else null
    val found = picked?.first
    if (wanted && found == null) {
      Log.i(TAG, "bit-perfect: the DAC offers nothing for a $depth-bit song at ${format.sampleRate}/${format.channelCount}ch (it offers $described)")
    }
    if (picked != null && found != null && manager.setPreferredMixerAttributes(attributes, usb, all[found])) {
      output = picked.second
      report(Way(device, true, format.sampleRate, sampleName(all[found].format.encoding), described))
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

/** The current output's AudioTrack: 32-bit integers where the sink writes them, else Media3's own. */
class IntegerTracks(private val mode: () -> Output) : DefaultAudioSink.AudioTrackProvider {
  private val made = DefaultAudioTrackProvider()

  override fun getAudioTrack(config: AudioSink.AudioTrackConfig, attributes: androidx.media3.common.AudioAttributes, audioSessionId: Int): android.media.AudioTrack =
    made.getAudioTrack(
      if (mode() == Output.INT32 && config.encoding == C.ENCODING_PCM_FLOAT) {
        AudioSink.AudioTrackConfig(C.ENCODING_PCM_32BIT, config.sampleRate, config.channelConfig, config.tunneling, config.offload, config.bufferSize)
      } else {
        config
      },
      attributes,
      audioSessionId
    )
}

/**
 * The player's audio sink: it prepares the mixer for each AudioTrack before it is made, writes the
 * integers a DAC takes (`Output`) in place of the decoder's float, and lets the spectrum
 * (Spectrum.kt) read the PCM it takes.
 */
class BitPerfectSink(private val context: Context, private val inner: AudioSink) : ForwardingAudioSink(inner) {
  /** What this sink writes now: set as it configures, read by the AudioTrack provider. */
  @Volatile var output = Output.FLOAT
    private set

  private var input: Format? = null
  private var channels: IntArray? = null

  /** The converted samples of the buffer being written: the inner sink wants the same one until it is all taken. */
  private var converted: ByteBuffer? = null
  private var convertedFrom: ByteBuffer? = null

  override fun configure(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
    input = inputFormat
    channels = outputChannels
    prepareSafely(inputFormat)
    Spectrum.configure(inputFormat.pcmEncoding, inputFormat.channelCount, inputFormat.sampleRate)
    configureInner(inputFormat, specifiedBufferSize, outputChannels)
  }

  /** The inner sink configured for what this one writes: 16-bit integers are its own format. */
  private fun configureInner(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
    output = if (inputFormat.pcmEncoding == C.ENCODING_PCM_FLOAT) BitPerfect.output else Output.FLOAT
    val written = if (output == Output.INT16) inputFormat.buildUpon().setPcmEncoding(C.ENCODING_PCM_16BIT).build() else inputFormat
    super.configure(written, if (output == Output.INT16) specifiedBufferSize / 2 else specifiedBufferSize, outputChannels)
  }

  override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    val from = buffer.position()
    val done = if (output == Output.FLOAT) {
      super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
    } else {
      handleConverted(buffer, presentationTimeUs, encodedAccessUnitCount)
    }
    // The bytes the sink took this time go to the spectrum, read through a copy of the buffer's
    // position: what is played is not touched.
    try {
      Spectrum.feed(buffer, from, buffer.position())
    } catch (error: Exception) {
      // The spectrum is decoration: a buffer it cannot read leaves it as it was.
    }
    return done
  }

  /**
   * The float samples in `buffer` written as integers: converted once, handed to the inner sink
   * until it has taken them all, and `buffer` moved on as far as it has (2 float bytes for each
   * 16-bit byte; 1 for 1 at 32 bits).
   */
  private fun handleConverted(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    if (convertedFrom !== buffer || converted == null) {
      converted = Integers.convert(buffer, output)
      convertedFrom = buffer
    }
    val out = converted!!
    val start = buffer.position()
    val outStart = out.position()
    val done = inner.handleBuffer(out, presentationTimeUs, encodedAccessUnitCount)
    if (done) {
      buffer.position(buffer.limit())
      converted = null
      convertedFrom = null
    } else {
      val taken = out.position() - outStart
      buffer.position(start + if (output == Output.INT16) taken * 2 else taken)
    }
    return done
  }

  // A flush lets the AudioTrack go, and the next one is made with the mixer as it then is: the
  // setting, changed while a song plays, is asked for again here (BitPerfect.pending), and the
  // inner sink configured anew for what is written now.
  override fun flush() {
    converted = null
    convertedFrom = null
    Spectrum.clear()
    super.flush()
    val format = input
    if (BitPerfect.pending && format != null) {
      prepareSafely(format)
      configureInner(format, 0, channels)
    }
  }

  override fun reset() {
    converted = null
    convertedFrom = null
    super.reset()
  }

  private fun prepareSafely(format: Format) {
    try {
      BitPerfect.prepare(context, format)
    } catch (error: Exception) {
      // The mixer's preference is a nicety: the song plays through Android's mixer.
      Log.w("jackbird", "bit-perfect: could not set the mixer's format", error)
      BitPerfect.output = Output.FLOAT
    }
  }
}

/** Float samples as integers, for a DAC that takes only those. */
object Integers {
  /**
   * The rest of `buffer` (float, little-endian as Android's) as 16- or 32-bit integers in a new
   * buffer, which the sink writes. A sample of a 16- or 24-bit song comes back as it was in the file
   * (float holds it exactly): `round(x * 2^15)` or `round(x * 2^31)`, kept within range.
   */
  fun convert(buffer: ByteBuffer, output: Output): ByteBuffer {
    val source = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    val count = source.remaining() / 4
    val out = ByteBuffer.allocateDirect(count * if (output == Output.INT16) 2 else 4).order(ByteOrder.nativeOrder())
    for (index in 0 until count) {
      val sample = source.getFloat(source.position() + index * 4)
      val value = if (sample.isNaN()) 0.0 else sample.toDouble()
      when (output) {
        Output.INT16 -> out.putShort(Math.round(value * 32768.0).coerceIn(-32768L, 32767L).toInt().toShort())
        else -> out.putInt(Math.round(value * 2147483648.0).coerceIn(-2147483648L, 2147483647L).toInt())
      }
    }
    out.flip()
    return out
  }
}
