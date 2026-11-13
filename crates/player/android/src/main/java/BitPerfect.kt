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
//
// In bit-perfect, Android applies no volume: the sink applies the phone's (Volume.kt), and the
// samples go untouched only at its top step.

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

  /** Whether the last `prepare` set the mixer bit-perfect: the sink then applies the phone's volume. */
  @Volatile var exclusive = false

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
    exclusive = false
    Volume.stop()
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
      exclusive = true
      Volume.follow(context, usb)
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
 * integers a DAC takes (`Output`) in place of the decoder's float, applies the phone's volume while
 * the track goes bit-perfect (Volume.kt), and lets the spectrum (Spectrum.kt) read the PCM it takes.
 */
class BitPerfectSink(private val context: Context, private val inner: AudioSink) : ForwardingAudioSink(inner) {
  /** What this sink writes now: set as it configures, read by the AudioTrack provider. */
  @Volatile var output = Output.FLOAT
    private set

  private var input: Format? = null
  private var channels: IntArray? = null

  /** Whether the AudioTrack goes bit-perfect: the phone's volume is then applied here. */
  private var exclusive = false

  /** The decoder's sample (C.ENCODING_PCM_*) and channels. */
  private var encoding = C.ENCODING_PCM_FLOAT
  private var channelCount = 2

  /** The gain last applied, which a change ramps from; NaN: none yet, and the next starts at its own. */
  private var applied = Float.NaN

  /** The converted samples of the buffer being written: the inner sink wants the same one until it is all taken. */
  private var converted: ByteBuffer? = null
  private var convertedFrom: ByteBuffer? = null

  /** A buffer the inner sink is taking as it is, for the same reason. */
  private var passing: ByteBuffer? = null

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
    // Into bit-perfect or out of it, the gain starts anew: Android's mixer applied the volume before.
    if (exclusive != BitPerfect.exclusive) applied = Float.NaN
    exclusive = BitPerfect.exclusive
    encoding = inputFormat.pcmEncoding
    channelCount = maxOf(1, inputFormat.channelCount)
    val written = if (output == Output.INT16) inputFormat.buildUpon().setPcmEncoding(C.ENCODING_PCM_16BIT).build() else inputFormat
    super.configure(written, if (output == Output.INT16) specifiedBufferSize / 2 else specifiedBufferSize, outputChannels)
  }

  override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    val from = buffer.position()
    val done = when {
      // A buffer the inner sink has begun goes on the way it began.
      passing === buffer -> passThrough(buffer, presentationTimeUs, encodedAccessUnitCount)
      convertedFrom === buffer && converted != null -> handleConverted(buffer, presentationTimeUs, encodedAccessUnitCount)
      converts() -> handleConverted(buffer, presentationTimeUs, encodedAccessUnitCount)
      else -> passThrough(buffer, presentationTimeUs, encodedAccessUnitCount)
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
   * Whether the next buffer is written converted: integers for a DAC that takes only those, or,
   * while the track goes bit-perfect, the phone's volume below its top (and the ramp back to it).
   */
  private fun converts(): Boolean =
    output != Output.FLOAT ||
      (exclusive && Pcm.handles(encoding) && (Volume.gain != 1f || (!applied.isNaN() && applied != 1f)))

  /** The buffer to the inner sink as it is. */
  private fun passThrough(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    val done = super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
    passing = if (done) null else buffer
    // Bit-perfect, a buffer goes as it is only at the top of the volume.
    if (exclusive) applied = 1f
    return done
  }

  /** What the sink writes, as C.ENCODING_PCM_*: integers for the DAC, else the decoder's own. */
  private fun writtenEncoding(): Int = when (output) {
    Output.INT16 -> C.ENCODING_PCM_16BIT
    Output.INT32 -> C.ENCODING_PCM_32BIT
    Output.FLOAT -> encoding
  }

  /**
   * The samples in `buffer` written converted (`writtenEncoding`, with the volume's gain while
   * bit-perfect, ramped across the buffer from the last one's): converted once, handed to the inner
   * sink until it has taken them all, and `buffer` moved on as far as it has.
   */
  private fun handleConverted(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
    val to = writtenEncoding()
    if (convertedFrom !== buffer || converted == null) {
      val gain = if (exclusive) Volume.gain else 1f
      converted = Pcm.convert(buffer, encoding, to, channelCount, if (applied.isNaN()) gain else applied, gain)
      convertedFrom = buffer
      applied = gain
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
      buffer.position(start + taken / Pcm.bytes(to) * Pcm.bytes(encoding))
    }
    return done
  }

  /** Forgets the buffers in progress: the inner sink has let them go. */
  private fun forget() {
    converted = null
    convertedFrom = null
    passing = null
    applied = Float.NaN
  }

  // A flush lets the AudioTrack go, and the next one is made with the mixer as it then is: the
  // setting, changed while a song plays, is asked for again here (BitPerfect.pending), and the
  // inner sink configured anew for what is written now.
  override fun flush() {
    forget()
    Spectrum.clear()
    super.flush()
    val format = input
    if (BitPerfect.pending && format != null) {
      prepareSafely(format)
      configureInner(format, 0, channels)
    }
  }

  override fun reset() {
    forget()
    super.reset()
  }

  private fun prepareSafely(format: Format) {
    try {
      BitPerfect.prepare(context, format)
    } catch (error: Exception) {
      // The mixer's preference is a nicety: the song plays through Android's mixer.
      Log.w("jackbird", "bit-perfect: could not set the mixer's format", error)
      BitPerfect.output = Output.FLOAT
      BitPerfect.exclusive = false
      Volume.stop()
    }
  }
}

/** PCM samples rewritten: in another encoding (integers for a DAC that takes only those), and with a gain (the volume). */
object Pcm {
  /** Whether `encoding` is one this can read and write. */
  fun handles(encoding: Int): Boolean =
    encoding == C.ENCODING_PCM_FLOAT || encoding == C.ENCODING_PCM_16BIT || encoding == C.ENCODING_PCM_24BIT || encoding == C.ENCODING_PCM_32BIT

  /** The bytes a sample of `encoding` takes. */
  fun bytes(encoding: Int): Int = when (encoding) {
    C.ENCODING_PCM_16BIT -> 2
    C.ENCODING_PCM_24BIT -> 3
    else -> 4
  }

  /**
   * The rest of `buffer` (little-endian, as Android's), samples of `from` interleaved over
   * `channels`, as `to` in a new buffer, which the sink writes; each frame times a gain going from
   * `gainFrom` at the first to `gainTo` at the last (the same gain all through when they are equal).
   * With a gain of 1, a sample of a 16- or 24-bit song comes back as it was in the file (float holds
   * it exactly): `round(x * 2^15)`, `2^23` or `2^31`, kept within range.
   */
  fun convert(buffer: ByteBuffer, from: Int, to: Int, channels: Int, gainFrom: Float, gainTo: Float): ByteBuffer {
    val source = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    val size = bytes(from)
    val count = source.remaining() / size
    val frames = maxOf(1, count / channels - 1)
    val out = ByteBuffer.allocateDirect(count * bytes(to)).order(ByteOrder.nativeOrder())
    val first = source.position()
    val ramp = gainTo.toDouble() - gainFrom.toDouble()
    for (index in 0 until count) {
      val at = first + index * size
      val sample = when (from) {
        C.ENCODING_PCM_16BIT -> source.getShort(at) / 32768.0
        C.ENCODING_PCM_24BIT ->
          ((source.get(at).toInt() and 0xff) or ((source.get(at + 1).toInt() and 0xff) shl 8) or (source.get(at + 2).toInt() shl 16)) / 8388608.0
        C.ENCODING_PCM_32BIT -> source.getInt(at) / 2147483648.0
        else -> source.getFloat(at).toDouble().let { if (it.isNaN()) 0.0 else it }
      }
      val gain = if (ramp == 0.0) gainTo.toDouble() else gainFrom + ramp * minOf(1.0, (index / channels).toDouble() / frames)
      val value = sample * gain
      when (to) {
        C.ENCODING_PCM_16BIT -> out.putShort(Math.round(value * 32768.0).coerceIn(-32768L, 32767L).toInt().toShort())
        C.ENCODING_PCM_24BIT -> {
          val integer = Math.round(value * 8388608.0).coerceIn(-8388608L, 8388607L).toInt()
          out.put(integer.toByte())
          out.put((integer shr 8).toByte())
          out.put((integer shr 16).toByte())
        }
        C.ENCODING_PCM_32BIT -> out.putInt(Math.round(value * 2147483648.0).coerceIn(-2147483648L, 2147483647L).toInt())
        else -> out.putFloat(value.toFloat())
      }
    }
    out.flip()
    return out
  }
}
