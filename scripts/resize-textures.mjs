// scripts/resize-textures.mjs — ESM version for Node 24+
import sharp from 'sharp'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readdirSync, renameSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'public', 'textures')
const TARGET_SIZE = 2048

const files = readdirSync(SRC).filter(f => /\.(jpe?g|png)$/i.test(f))

for (const file of files) {
    const input = join(SRC, file)
    const tmp = input + '.tmp.jpg'
    const meta = await sharp(input).metadata()
    console.log(`${file}: ${meta.width}x${meta.height} → ${TARGET_SIZE}x${TARGET_SIZE}`)
    await sharp(input)
        .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 88, progressive: true })
        .toFile(tmp)
    renameSync(tmp, input)
    console.log(`  ✓ ${file}`)
}
console.log('\n✅ All textures resized to 2048×2048.')
