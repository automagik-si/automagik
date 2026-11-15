package ai.namastex.automagik

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A Codex pet atlas (v1: 9 rows, v2: 11) of 192x208 cells, 8 to a row, and its sleep strip of 6 cells: the format of
 * the Bot team's pets (apps/bots-dsh/src/client/pet-poses.js ROWS and SLEEP, mirrored here and checked by TeamsTest).
 */
object PetAtlas {
    const val CELL_W = 192
    const val CELL_H = 208
    data class Row(val index: Int, val ms: List<Long>)
    private fun even(count: Int, ms: Long, last: Long) = List(count - 1) { ms } + last
    val ROWS = mapOf(
        "idle" to Row(0, listOf(280, 110, 110, 140, 140, 320)),
        "running-right" to Row(1, even(8, 120, 220)),
        "running-left" to Row(2, even(8, 120, 220)),
        "waving" to Row(3, even(4, 140, 280)),
        "jumping" to Row(4, even(5, 140, 280)),
        "failed" to Row(5, even(8, 140, 240)),
        "waiting" to Row(6, even(6, 150, 260)),
        "running" to Row(7, even(6, 120, 220)),
        "review" to Row(8, even(6, 150, 280)))
    /** The sleep strip: the pet's own image, one row of 6 cells. */
    val SLEEP = List(6) { 320L }
    /** A pet without a sleep strip dozes in a slow idle. */
    val SLOW_IDLE = ROWS.getValue("idle").ms.map { it * 3 }
}

/**
 * Where a pet's images come from: Genie from the APK (bundled at build time from apps/bots-dsh), any other pet from the
 * phone's own copy of what the desktop baked into ~/.automagik/bots/pets/<id>/ (fetched over Pocket Link). Decoded at
 * half size (96x104 a cell), which is plenty for a 52 dp face and a quarter of the memory.
 */
object Pets {
    class Atlas(val sheet: ImageBitmap, val sleep: ImageBitmap?, val scale: Int)
    private val cache = LruCache<String, Atlas>(12)
    private const val SAMPLE = 2

    fun dir(context: Context) = File(context.filesDir, "pets")
    /** The phone has this pet's sheet (the desktop's copy, fetched before). */
    fun cached(context: Context, id: String) = File(dir(context), "$id/spritesheet.webp").isFile
    /** Stores a fetched pet: its sheet, and its sleep strip when it has one. A sheet that doesn't decode is not kept. */
    fun save(context: Context, id: String, sheet: ByteArray, sleep: ByteArray?): Boolean {
        val pet = Teams.petId(id) ?: return false
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { BitmapFactory.decodeByteArray(sheet, 0, sheet.size, it) }
        if (bounds.outWidth != PetAtlas.CELL_W * 8 || bounds.outHeight < PetAtlas.CELL_H * 9) return false
        val into = File(dir(context), pet).apply { mkdirs() }
        File(into, "spritesheet.webp.tmp").apply { writeBytes(sheet); renameTo(File(into, "spritesheet.webp")) }
        sleep?.let { File(into, "sleep.webp.tmp").apply { writeBytes(it); renameTo(File(into, "sleep.webp")) } }
        synchronized(cache) { cache.remove(pet) }
        return true
    }

    private fun decode(bytes: ByteArray?): ImageBitmap? = bytes?.let {
        BitmapFactory.decodeByteArray(it, 0, it.size, BitmapFactory.Options().apply { inSampleSize = SAMPLE; inPreferredConfig = Bitmap.Config.ARGB_8888 })
            ?.asImageBitmap()
    }

    /** The atlas for [id], else Genie's. Blocking: call it off the main thread. */
    /** The atlas already in memory for [id], so a new pet view does not start blank for a frame. */
    fun peek(context: Context, id: String?): Atlas? {
        val want = Teams.petId(id)?.takeIf { cached(context, it) } ?: Teams.GENIE
        return synchronized(cache) { cache.get(want) }
    }

    fun load(context: Context, id: String?): Atlas? {
        val want = Teams.petId(id)?.takeIf { cached(context, it) } ?: Teams.GENIE
        synchronized(cache) { cache.get(want) }?.let { return it }
        val atlas = runCatching {
            if (want == Teams.GENIE) {
                fun asset(name: String) = runCatching { context.assets.open("pets/${Teams.GENIE}/$name").use { it.readBytes() } }.getOrNull()
                decode(asset("spritesheet.webp"))?.let { Atlas(it, decode(asset("sleep.webp")), SAMPLE) }
            } else {
                val d = File(dir(context), want)
                decode(File(d, "spritesheet.webp").readBytes())?.let { Atlas(it, File(d, "sleep.webp").takeIf { f -> f.isFile }?.let { f -> decode(f.readBytes()) }, SAMPLE) }
            }
        }.getOrNull() ?: return null
        synchronized(cache) { cache.put(want, atlas) }
        return atlas
    }
}

/**
 * A bot's pet in the pose for its state: the state's `once` row first (needs-you waves once), then its loop. A new
 * [celebrate] key plays the merge celebration, one jump, then goes back to the loop. Nothing shows until the atlas loads.
 */
@Composable fun PetView(pet: String?, pose: String, size: Dp, modifier: Modifier = Modifier, celebrate: Any? = null, still: Boolean = false) {
    val context = LocalContext.current
    val version = LocalIconsVersion.current
    val atlas by produceState<Pets.Atlas?>(Pets.peek(context, pet), pet, version) {
        value = withContext(Dispatchers.IO) { Pets.load(context, pet) }
    }
    var row by remember { mutableStateOf("idle") }
    var frame by remember { mutableIntStateOf(0) }
    val a = atlas
    LaunchedEffect(pose, celebrate, a, still) {
        if (a == null) return@LaunchedEffect
        val plan = Teams.petRow(pose)
        suspend fun play(name: String, times: Int) {
            row = name
            val ms = if (name == "sleep") (if (a.sleep != null) PetAtlas.SLEEP else PetAtlas.SLOW_IDLE) else PetAtlas.ROWS.getValue(name).ms
            var n = 0
            while (times < 0 || n < times) {
                for (i in ms.indices) { frame = i; delay(ms[i]) }
                n++
            }
        }
        if (still) { row = plan.row; frame = 0; return@LaunchedEffect }
        if (celebrate != null) play(Teams.EVENT_ROWS.getValue("merged"), 1)
        plan.once?.let { play(it, 1) }
        play(plan.row, -1)
    }
    Canvas(modifier.size(size)) {
        val atlasNow = a ?: return@Canvas
        val cw = PetAtlas.CELL_W / atlasNow.scale
        val ch = PetAtlas.CELL_H / atlasNow.scale
        val (image, x, y) = when {
            row == "sleep" && atlasNow.sleep != null -> Triple(atlasNow.sleep, frame.coerceIn(0, 5) * cw, 0)
            row == "sleep" -> Triple(atlasNow.sheet, frame.coerceIn(0, 5) * cw, 0)
            else -> Triple(atlasNow.sheet, frame * cw, PetAtlas.ROWS.getValue(row).index * ch)
        }
        // The cell is taller than wide: fit its height, centred.
        val h = this.size.height.toInt()
        val w = (h * cw / ch)
        drawImage(image, IntOffset(x, y), IntSize(cw, ch), IntOffset(((this.size.width - w) / 2).toInt(), 0), IntSize(w, h),
            filterQuality = FilterQuality.Medium)
    }
}
