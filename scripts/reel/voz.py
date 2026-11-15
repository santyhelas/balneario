# Genera la voz de cada línea (voz neuronal es-AR) y los tiempos de cada palabra para los subtítulos.
import asyncio, json, sys, edge_tts
VOICE = sys.argv[1] if len(sys.argv) > 1 else "es-AR-TomasNeural"
RATE = sys.argv[2] if len(sys.argv) > 2 else "+10%"
PITCH = sys.argv[3] if len(sys.argv) > 3 else "+0Hz"
async def one(i, text):
    words = []
    c = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH, boundary="WordBoundary")
    with open(f"out/l{i:02d}.mp3", "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio": f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append({"t": ch["offset"] / 1e7, "d": ch["duration"] / 1e7, "w": ch["text"]})
    return {"i": i, "text": text, "words": words}
async def main():
    lines = json.load(open("scripts/reel/lineas.json"))
    res = [await one(i, t) for i, t in enumerate(lines)]
    json.dump(res, open("out/palabras.json", "w"), ensure_ascii=False, indent=1)
asyncio.run(main())
