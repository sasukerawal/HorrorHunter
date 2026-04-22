// scripts/resize-textures.js
// Resizes all photogrammetry textures to 2048x2048 (power-of-two) for Three.js
// Usage: node scripts/resize-textures.js
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

const SRC = path.join(__dirname, '..', 'public', 'textures')
const DST = path.join(__dirname, '..', 'public', 'textures')
const TARGET_SIZE = 2048

const files = fs.readdirSync(SRC).filter(f => /\.(jpe?g|png)$/i.test(f))

    ; (async () => {
        for (const file of files) {
            const input = path.join(SRC, file)
            const output = path.join(DST, file)
            const meta = await sharp(input).metadata()
            console.log(`${file}: ${meta.width}x${meta.height} → ${TARGET_SIZE}x${TARGET_SIZE}`)
            await sharp(input)
                .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover', position: 'center' })
                .jpeg({ quality: 88, progressive: true })
                .toFile(output + '.tmp.jpg')
            fs.renameSync(output + '.tmp.jpg', output)
            console.log(`  ✓ Saved ${file}`)
        }
        console.log('\nAll textures resized to 2048×2048.')
    })()
