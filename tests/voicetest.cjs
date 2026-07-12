// Two-browser proximity-voice test with fake microphones (Chrome generates a tone).
// Requires the dev servers running:  node server/index.cjs  +  npx vite
// Usage:  node tests/voicetest.cjs             → normal path (expects WebRTC P2P)
//         node tests/voicetest.cjs --kill-udp  → WebRTC stubbed dead (expects socket relay)
// Override the browser with CHROME=<path to chrome.exe> if needed.
const puppeteer = require('puppeteer-core')

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5173'
const KILL_UDP = process.argv.includes('--kill-udp')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function launch(tag) {
    const args = [
        '--use-fake-ui-for-media-stream',      // auto-grant cam/mic
        '--use-fake-device-for-media-stream',  // fake mic = generated tone
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',                        // don't blast the real speakers
        '--no-first-run', '--no-default-browser-check',
    ]
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args,
    })
    const page = (await browser.pages())[0]
    if (KILL_UDP) {
        // Break WebRTC entirely — connections can be created but never succeed.
        // This forces the socket.io relay fallback path.
        await page.evaluateOnNewDocument(() => {
            window.RTCPeerConnection = class {
                constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.iceConnectionState = 'new'; this.remoteDescription = null }
                addTrack() {} addTransceiver() {}
                createOffer()  { return Promise.reject(new Error('webrtc disabled by test')) }
                createAnswer() { return Promise.reject(new Error('webrtc disabled by test')) }
                setLocalDescription()  { return Promise.resolve() }
                setRemoteDescription() { return Promise.resolve() }
                addIceCandidate()      { return Promise.resolve() }
                close() {}
            }
        })
    }
    page.on('console', m => {
        const t = m.text()
        if (t.includes('[Voice]') || t.includes('[GAME ERROR]') || m.type() === 'error') {
            console.log(`  [${tag}]`, t.slice(0, 160))
        }
    })
    page.on('pageerror', e => console.log(`  [${tag}] PAGEERROR`, String(e).slice(0, 200)))
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
    return { browser, page, tag }
}

// Measure RMS at a node for `ms` milliseconds (0..~1)
async function measureRMS(page, ms = 2500) {
    return page.evaluate(async (ms) => {
        const v = window.__bh?.voice
        const ctx = v?._getAudioContext?.()
        if (!v || !ctx) return { err: 'no voice/ctx' }
        if (!v._voiceOut) return { err: 'no voiceOut node (no graph built yet)' }
        const an = ctx.createAnalyser()
        an.fftSize = 2048
        v._voiceOut.connect(an)
        const data = new Float32Array(an.fftSize)
        let peak = 0, sumAll = 0, n = 0
        const t0 = performance.now()
        while (performance.now() - t0 < ms) {
            an.getFloatTimeDomainData(data)
            let s = 0
            for (let i = 0; i < data.length; i++) s += data[i] * data[i]
            const rms = Math.sqrt(s / data.length)
            peak = Math.max(peak, rms)
            sumAll += rms; n++
            await new Promise(r => setTimeout(r, 50))
        }
        try { v._voiceOut.disconnect(an) } catch {}
        return { peakRMS: +peak.toFixed(4), avgRMS: +(sumAll / n).toFixed(4), ctxState: ctx.state }
    }, ms)
}

async function snapshot(page) {
    return page.evaluate(() => {
        const v = window.__bh?.voice
        if (!v) return { err: 'no __bh.voice' }
        const pcs = {}
        for (const [id, pc] of v.peerConnections) pcs[id] = { conn: pc.connectionState, ice: pc.iceConnectionState, sig: pc.signalingState }
        const graphs = {}
        for (const [id, g] of v.remoteGraphs) graphs[id] = {
            hasSource: !!g.source, elPaused: g.el ? g.el.paused : null,
            gain: +g.gain.gain.value.toFixed(3),
        }
        return {
            role: v.role, micLive: !!v.localStream, transmitting: v.isTransmitting(),
            vadOpen: v._vadOpen, rms: +v._currentRMS.toFixed(4),
            relaySend: v._relaySend, webrtcLive: [...v._webrtcLive],
            ctx: v._getAudioContext()?.state, status: document.getElementById('voice-status')?.textContent,
            pcs, graphs,
        }
    })
}

;(async () => {
    console.log(`=== VOICE TEST ${KILL_UDP ? '(UDP DISABLED — expecting RELAY)' : '(normal — expecting P2P)'} ===`)
    const A = await launch('A')
    const B = await launch('B')

    // A hosts
    await A.page.click('#btn-host')
    await A.page.waitForFunction(() => document.getElementById('room-code').textContent !== '----', { timeout: 10000 })
    const code = await A.page.$eval('#room-code', el => el.textContent)
    console.log('room code:', code)

    // B joins
    await B.page.type('#code-input', code)
    await B.page.click('#btn-join')
    await A.page.waitForFunction(() => document.getElementById('player-count')?.textContent.includes('2/'), { timeout: 10000 })

    // A starts
    await A.page.click('#btn-start-game')
    for (const s of [A, B]) {
        await s.page.waitForFunction(() => !document.getElementById('hud')?.classList.contains('hidden'), { timeout: 60000 })
    }
    console.log('game started on both clients; waiting for voice to settle…')
    await sleep(KILL_UDP ? 14000 : 8000)   // give ICE (or the 8s relay grace) time

    // Normal mode: NO forcing — the always-on WebRTC track must carry audio by itself.
    // Relay mode: hold PTT (relay is VAD/PTT-gated by design for bandwidth).
    if (KILL_UDP) {
        for (const s of [A, B]) await s.page.evaluate(() => window.__bh.voice.pttHeld(true))
        await sleep(1000)
    }

    for (const s of [A, B]) {
        console.log(`\n--- ${s.tag} snapshot ---`)
        console.log(JSON.stringify(await snapshot(s.page), null, 1))
    }

    console.log('\nmeasuring received voice audio (4 s each)…')
    const [rmsA, rmsB] = await Promise.all([measureRMS(A.page, 4000), measureRMS(B.page, 4000)])
    console.log('A hears:', JSON.stringify(rmsA))
    console.log('B hears:', JSON.stringify(rmsB))

    const ok = (rmsA.peakRMS ?? 0) > 0.01 && (rmsB.peakRMS ?? 0) > 0.01
    console.log(ok ? '\n✅ VOICE AUDIBLE ON BOTH CLIENTS' : '\n❌ VOICE SILENT — see snapshots above')

    await A.browser.close()
    await B.browser.close()
    process.exit(ok ? 0 : 1)
})().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2) })
