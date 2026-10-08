import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff, MAX_DIFF_LINES_PER_FILE } from '../server/lib/diff-parser.mjs'

const modifiedDiff = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,4 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a }
 // end
`

test('parses a modified file with old/new line numbers', () => {
  const files = parseUnifiedDiff(modifiedDiff)
  assert.equal(files.length, 1)
  const file = files[0]
  assert.equal(file.path, 'src/a.js')
  assert.equal(file.oldPath, null)
  assert.equal(file.changeType, 'modified')
  assert.equal(file.binary, false)
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)
  assert.equal(file.hunks.length, 1)
  const hunk = file.hunks[0]
  assert.deepEqual({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines }, { oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 })
  assert.deepEqual(hunk.lines.map((line) => [line.type, line.oldNo, line.newNo, line.text]), [
    ['context', 1, 1, 'const a = 1'],
    ['del', 2, null, 'const b = 2'],
    ['add', null, 2, 'const b = 3'],
    ['add', null, 3, 'const c = 4'],
    ['context', 3, 4, 'export { a }'],
    ['context', 4, 5, '// end']
  ])
})

test('parses added, deleted, renamed and binary files', () => {
  const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old-name.js b/new-name.js
similarity index 90%
rename from old-name.js
rename to new-name.js
index 1111111..2222222 100644
--- a/old-name.js
+++ b/new-name.js
@@ -1 +1 @@
-x
+y
diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`
  const files = parseUnifiedDiff(diff)
  assert.deepEqual(files.map((file) => [file.path, file.oldPath, file.changeType, file.binary, file.additions, file.deletions]), [
    ['new.txt', null, 'added', false, 2, 0],
    ['gone.txt', null, 'deleted', false, 0, 1],
    ['new-name.js', 'old-name.js', 'renamed', false, 1, 1],
    ['img.png', null, 'modified', true, 0, 0]
  ])
  assert.equal(files[0].hunks[0].lines[0].newNo, 1)
  assert.equal(files[1].hunks[0].lines[0].oldNo, 1)
  assert.deepEqual(files[3].hunks, [])
})

test('handles "\\ No newline at end of file" markers and multiple hunks', () => {
  const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
 one
-two
+TWO
@@ -10,2 +10,2 @@
 ten
-eleven
\\ No newline at end of file
+ELEVEN
\\ No newline at end of file
`
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.hunks.length, 2)
  assert.equal(file.hunks[1].oldStart, 10)
  assert.deepEqual(file.hunks[1].lines.map((line) => line.text), ['ten', 'eleven', 'ELEVEN'])
  assert.equal(file.hunks[1].lines[2].newNo, 11)
})

test('truncates files whose diff exceeds the line cap', () => {
  const lines = []
  for (let index = 0; index < MAX_DIFF_LINES_PER_FILE + 1; index += 1) lines.push(`+line ${index}`)
  const diff = `diff --git a/big b/big\n--- /dev/null\n+++ b/big\n@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}\n`
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.truncated, true)
  assert.deepEqual(file.hunks, [])
  assert.equal(file.additions, lines.length)
})

test('returns an empty list for empty input', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
})

test('untracked files produced by git diff --no-index are tagged when requested', () => {
  const diff = `diff --git a/dev/null b/notes.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/notes.md
@@ -0,0 +1 @@
+todo
`
  const [file] = parseUnifiedDiff(diff, { changeType: 'untracked' })
  assert.equal(file.path, 'notes.md')
  assert.equal(file.changeType, 'untracked')
})
