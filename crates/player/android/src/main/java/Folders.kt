// A folder of the phone as a library's source (E6b-D9, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
// 2026-11-11 23:33 and after): chosen in Android's own folder picker, which grants the app that
// folder alone, for good (a persisted permission on its tree). Everything in it is reached through
// Android's document provider by the path relative to the folder: listing, small files, renames,
// and the files themselves opened for Rust's tag engine (as `/proc/self/fd/<n>`) and for the player
// (by their `content://` address). Nothing here asks for access to any other file.

package es.germade.jackbird.player

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.FileNotFoundException
import java.util.concurrent.ConcurrentHashMap

/** One entry of a folder: its path in the tree, its name, whether a folder, its size and date. */
data class Found(val path: String, val name: String, val folder: Boolean, val size: Long, val mtime: Long)

class Folders(private val resolver: ContentResolver) {
  /** Document ids by tree and path, filled as the tree is walked and looked up. */
  private val ids = ConcurrentHashMap<String, String>()
  /** The files opened for Rust, by their descriptor's number. */
  private val open = ConcurrentHashMap<Int, ParcelFileDescriptor>()

  private val columns = arrayOf(
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED
  )

  private fun key(tree: Uri, path: String) = "$tree\n$path"

  /** Whether the app still holds the person's permission for this folder. */
  fun granted(tree: Uri): Boolean = resolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }

  /** The folder's own name. */
  fun name(tree: Uri): String =
    resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)), arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)
      ?.use { if (it.moveToFirst()) it.getString(0) else null }
      ?: tree.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "Folder"

  /** The children of a document, as entries under `prefix`. */
  private fun children(tree: Uri, parentId: String, prefix: String): List<Pair<Found, String>> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val out = mutableListOf<Pair<Found, String>>()
    resolver.query(uri, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val id = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        val folder = cursor.getString(2) == Document.MIME_TYPE_DIR
        val path = if (prefix.isEmpty()) name else "$prefix/$name"
        val size = if (cursor.isNull(3)) 0L else cursor.getLong(3)
        val mtime = if (cursor.isNull(4)) 0L else cursor.getLong(4)
        ids[key(tree, path)] = id
        out.add(Found(path, name, folder, size, mtime) to id)
      }
    }
    return out
  }

  /** A path's document id, looked up name by name from the folder when not known yet; null when it is not there. */
  private fun idOf(tree: Uri, path: String): String? {
    val clean = path.trim('/')
    if (clean.isEmpty()) return DocumentsContract.getTreeDocumentId(tree)
    ids[key(tree, clean)]?.let { return it }
    var parentId = DocumentsContract.getTreeDocumentId(tree)
    var prefix = ""
    for (name in clean.split('/')) {
      val here = if (prefix.isEmpty()) name else "$prefix/$name"
      val known = ids[key(tree, here)]
      parentId = known ?: (children(tree, parentId, prefix).firstOrNull { it.first.name == name }?.second ?: return null)
      prefix = here
    }
    return parentId
  }

  private fun uriOf(tree: Uri, path: String): Uri? = idOf(tree, path)?.let { DocumentsContract.buildDocumentUriUsingTree(tree, it) }

  private fun need(tree: Uri, path: String): Uri = uriOf(tree, path) ?: throw FileNotFoundException(path)

  /** Every file under the folder (not its folders), by path. */
  fun walk(tree: Uri): List<Found> {
    val files = mutableListOf<Found>()
    val pending = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(tree) to ""))
    while (pending.isNotEmpty()) {
      val (id, prefix) = pending.removeFirst()
      for ((found, childId) in children(tree, id, prefix)) {
        if (found.folder) pending.add(childId to found.path) else files.add(found)
      }
    }
    return files.sortedBy { it.path }
  }

  /** The entries of one folder of the tree. */
  fun list(tree: Uri, path: String): List<Found> = children(tree, idOf(tree, path) ?: throw FileNotFoundException(path), path.trim('/')).map { it.first }

  /** One entry's kind, size and date; null when it is not there. */
  fun stat(tree: Uri, path: String): Found? {
    val uri = uriOf(tree, path) ?: return null
    return resolver.query(uri, columns, null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      Found(
        path.trim('/'),
        cursor.getString(1) ?: "",
        cursor.getString(2) == Document.MIME_TYPE_DIR,
        if (cursor.isNull(3)) 0L else cursor.getLong(3),
        if (cursor.isNull(4)) 0L else cursor.getLong(4)
      )
    }
  }

  /** A small file's bytes. */
  fun read(tree: Uri, path: String): ByteArray =
    resolver.openInputStream(need(tree, path))?.use { it.readBytes() } ?: throw FileNotFoundException(path)

  /** A folder of the tree, made with the folders above it that are missing; its document id. */
  fun mkdir(tree: Uri, path: String): String {
    val clean = path.trim('/')
    idOf(tree, clean)?.let { return it }
    val parent = clean.substringBeforeLast('/', "")
    val parentId = mkdir(tree, parent)
    val made = DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, parentId), Document.MIME_TYPE_DIR, clean.substringAfterLast('/'))
      ?: throw FileNotFoundException(clean)
    val id = DocumentsContract.getDocumentId(made)
    ids[key(tree, clean)] = id
    return id
  }

  /** Writes a small file whole, made if it is not there. */
  fun write(tree: Uri, path: String, bytes: ByteArray) {
    val clean = path.trim('/')
    val uri = uriOf(tree, clean) ?: run {
      val parentId = mkdir(tree, clean.substringBeforeLast('/', ""))
      val made = DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, parentId), "application/octet-stream", clean.substringAfterLast('/'))
        ?: throw FileNotFoundException(clean)
      ids[key(tree, clean)] = DocumentsContract.getDocumentId(made)
      made
    }
    resolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: throw FileNotFoundException(clean)
  }

  /** Removes a file or a folder. */
  fun delete(tree: Uri, path: String) {
    DocumentsContract.deleteDocument(resolver, need(tree, path))
    forget(tree, path)
  }

  /** Renames or moves an entry within the folder. */
  fun rename(tree: Uri, from: String, to: String) {
    val source = need(tree, from)
    val (fromParent, fromName) = from.trim('/').let { it.substringBeforeLast('/', "") to it.substringAfterLast('/') }
    val (toParent, toName) = to.trim('/').let { it.substringBeforeLast('/', "") to it.substringAfterLast('/') }
    var moved = source
    if (fromParent != toParent) {
      val targetId = mkdir(tree, toParent)
      moved = DocumentsContract.moveDocument(
        resolver,
        source,
        DocumentsContract.buildDocumentUriUsingTree(tree, idOf(tree, fromParent) ?: throw FileNotFoundException(fromParent)),
        DocumentsContract.buildDocumentUriUsingTree(tree, targetId)
      ) ?: throw FileNotFoundException(to)
    }
    if (fromName != toName) moved = DocumentsContract.renameDocument(resolver, moved, toName) ?: throw FileNotFoundException(to)
    forget(tree, from)
    ids[key(tree, to.trim('/'))] = DocumentsContract.getDocumentId(moved)
  }

  /** Forgets the ids at and under a path (it moved or went). */
  private fun forget(tree: Uri, path: String) {
    val at = key(tree, path.trim('/'))
    ids.keys.removeIf { it == at || it.startsWith("$at/") }
  }

  /** A file's `content://` address, for the player. */
  fun address(tree: Uri, path: String): String = need(tree, path).toString()

  /** Opens a file for Rust ("r", or "rw" to write its tags in place); its descriptor's number. */
  fun openFile(tree: Uri, path: String, write: Boolean): Int {
    val descriptor = resolver.openFileDescriptor(need(tree, path), if (write) "rw" else "r") ?: throw FileNotFoundException(path)
    open[descriptor.fd] = descriptor
    return descriptor.fd
  }

  /** Closes a file opened for Rust. */
  fun closeFile(fd: Int) {
    open.remove(fd)?.close()
  }
}
