// The spectrum of what the player hands Android, for the display's analyser on a phone: the PCM the
// sink takes (BitPerfectSink.handleBuffer), read without changing it, its channels mixed to one,
// some seconds of it kept with the song's time of its last sample. What the sink takes is heard
// later, by as much as Android's output holds (a quarter of a second, more over Bluetooth): the
// sink's own clock says what is heard now (its getCurrentPositionUs, which counts that), so the
// 8192 samples taken are the ones heard then, not the ones just handed over. When the page asks
// (the `spectrum` command), they are turned into bins as Web Audio's AnalyserNode gives them with
// getByteFrequencyData: the same as the desktop's
// (crates/audio/src/spectrum.rs, which this ports: a Blackman window, magnitudes over the window's
// length smoothed with the previous ones, -90 to -10 dB scaled to 0-255). The page makes bands of
// them as it does for the others (src/helpers/spectrum.ts).

package es.germade.jackbird.player

import androidx.media3.common.C
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

object Spectrum {
  private const val SIZE = 8192
  private const val BINS = SIZE / 2
  private const val SMOOTHING = 0.6f
  private const val MIN_DB = -90f
  private const val MAX_DB = -10f

  /** What is kept: enough for Android's output and a Bluetooth link (6 s at 44.1 kHz, 1.4 s at 192). */
  private const val KEPT = 1 shl 18
  private val ring = FloatArray(KEPT)
  private var at = 0
  private val lock = Any()

  /** The song's time (µs, the sink's) of the last sample kept; NOT_SET: none yet. */
  private var headUs = NOT_SET
  /** The sink's clock: what was heard when it was last asked (µs), and when (System.nanoTime). */
  @Volatile private var heardUs = NOT_SET
  @Volatile private var heardAtNanos = 0L
  /** How far the clock is carried on past its last reading: the player asks it every few ms while it plays. */
  private const val CARRY_US = 100_000L
  private const val NOT_SET = Long.MIN_VALUE

  private val window = FloatArray(SIZE) { index ->
    val x = index.toFloat() / SIZE
    (0.42 - 0.5 * cos(2 * PI * x) + 0.08 * cos(4 * PI * x)).toFloat()
  }
  private val smoothed = FloatArray(BINS)
  private val real = FloatArray(SIZE)
  private val imaginary = FloatArray(SIZE)

  /** The format of what the sink takes, from its `configure`. */
  @Volatile var encoding: Int = C.ENCODING_INVALID
  @Volatile var channels: Int = 0
  @Volatile var rate: Int = 0

  /** Whether something was heard since the last silence (a flush, a stop). */
  @Volatile private var heard = false

  /** The format the sink was configured with. */
  fun configure(encoding: Int, channels: Int, rate: Int) {
    this.encoding = encoding
    this.channels = max(1, channels)
    this.rate = rate
  }

  /** Forgets what was heard: a seek, a stop. */
  fun clear() {
    synchronized(lock) {
      ring.fill(0f)
      at = 0
      heard = false
      headUs = NOT_SET
      heardUs = NOT_SET
    }
  }

  /** What the sink's clock says is heard now (the song's time, µs): the samples heard are taken from there. */
  fun heard(positionUs: Long) {
    heardUs = positionUs
    heardAtNanos = System.nanoTime()
  }

  /**
   * Takes the PCM in `bytes` from `from` to `to` (the part the sink consumed), mixed to one channel;
   * `endUs` is the song's time just after its last sample.
   */
  fun feed(bytes: ByteBuffer, from: Int, to: Int, endUs: Long) {
    val frameBytes = when (encoding) {
      C.ENCODING_PCM_16BIT -> 2
      C.ENCODING_PCM_24BIT -> 3
      C.ENCODING_PCM_32BIT, C.ENCODING_PCM_FLOAT -> 4
      else -> return
    } * channels
    if (to <= from) return
    val view = bytes.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    // Only the last KEPT frames matter.
    val frames = (to - from) / frameBytes
    val first = from + max(0, frames - KEPT) * frameBytes
    synchronized(lock) {
      var offset = first
      while (offset + frameBytes <= to) {
        var sum = 0f
        for (channel in 0 until channels) sum += sample(view, offset + channel * (frameBytes / channels))
        ring[at] = sum / channels
        at = (at + 1) % KEPT
        offset += frameBytes
      }
      headUs = endUs
      heard = true
    }
  }

  /** How many samples before the last one kept is what is heard now: none while the clock is not known. */
  private fun behind(): Int {
    val clock = heardUs
    if (clock == NOT_SET || headUs == NOT_SET || rate <= 0) return 0
    val now = clock + min(CARRY_US, (System.nanoTime() - heardAtNanos) / 1000)
    val samples = (headUs - now) * rate / 1_000_000
    return samples.coerceIn(0L, (KEPT - SIZE).toLong()).toInt()
  }

  private fun sample(view: ByteBuffer, offset: Int): Float = when (encoding) {
    C.ENCODING_PCM_16BIT -> view.getShort(offset) / 32768f
    C.ENCODING_PCM_24BIT -> {
      val value = (view.get(offset).toInt() and 0xff) or
        ((view.get(offset + 1).toInt() and 0xff) shl 8) or
        (view.get(offset + 2).toInt() shl 16)
      value / 8388608f
    }
    C.ENCODING_PCM_32BIT -> view.getInt(offset) / 2147483648f
    C.ENCODING_PCM_FLOAT -> view.getFloat(offset)
    else -> 0f
  }

  /** The bins (0-255, low frequencies first) of the SIZE samples heard now, or null with nothing heard. */
  fun bins(): IntArray? {
    synchronized(lock) {
      if (!heard) return null
      // The window ends where what is heard now is.
      val start = ((at - behind() - SIZE) % KEPT + KEPT) % KEPT
      for (index in 0 until SIZE) {
        val value = ring[(start + index) % KEPT]
        real[index] = (if (value.isFinite()) min(1f, max(-1f, value)) else 0f) * window[index]
        imaginary[index] = 0f
      }
    }
    fft(real, imaginary)
    return IntArray(BINS) { index ->
      val magnitude = hypot(real[index], imaginary[index]) / SIZE
      val next = SMOOTHING * smoothed[index] + (1 - SMOOTHING) * magnitude
      smoothed[index] = if (next.isFinite()) next else 0f
      val decibels = 20 * log10(max(smoothed[index], 1e-12f))
      val scaled = 255 * (decibels - MIN_DB) / (MAX_DB - MIN_DB)
      min(255f, max(0f, scaled)).toInt()
    }
  }

  /** An in-place radix-2 FFT of a power-of-two length (crates/audio's). */
  private fun fft(real: FloatArray, imaginary: FloatArray) {
    val size = real.size
    var swap = 0
    for (index in 1 until size) {
      var bit = size shr 1
      while (swap and bit != 0) {
        swap = swap xor bit
        bit = bit shr 1
      }
      swap = swap or bit
      if (index < swap) {
        real[index] = real[swap].also { real[swap] = real[index] }
        imaginary[index] = imaginary[swap].also { imaginary[swap] = imaginary[index] }
      }
    }
    var length = 2
    while (length <= size) {
      val angle = -2 * PI / length
      val stepReal = cos(angle).toFloat()
      val stepImaginary = sin(angle).toFloat()
      var start = 0
      while (start < size) {
        var turnReal = 1f
        var turnImaginary = 0f
        for (offset in 0 until length / 2) {
          val even = start + offset
          val odd = even + length / 2
          val oddReal = real[odd] * turnReal - imaginary[odd] * turnImaginary
          val oddImaginary = real[odd] * turnImaginary + imaginary[odd] * turnReal
          real[odd] = real[even] - oddReal
          imaginary[odd] = imaginary[even] - oddImaginary
          real[even] += oddReal
          imaginary[even] += oddImaginary
          val nextReal = turnReal * stepReal - turnImaginary * stepImaginary
          turnImaginary = turnReal * stepImaginary + turnImaginary * stepReal
          turnReal = nextReal
        }
        start += length
      }
      length = length shl 1
    }
  }
}
