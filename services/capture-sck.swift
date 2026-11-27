// capture-sck — ScreenCaptureKit audio-only → stdout PCM s16le mono.
// Captura o áudio RENDERIZADO por app(s) — sem Multi-Output, sem BlackHole,
// sem mudar routing. Filtro por app = o TTS de outro processo NÃO entra (eco zero).
// Compilar: swiftc -O services/capture-sck.swift -o services/capture-sck
// Uso: capture-sck [--app Teams] [--rate 16000]   (sem --app = todos os apps)
// stdout = SÓ PCM; logs em stderr. Precisa de permissão de Gravação de Tela (TCC).
import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio
import AppKit

var appName = ""
var rate = 16000
var listOnly = false
let args = CommandLine.arguments
var pidExcludes = Set<Int32>()
var nameExcludes = Set<String>()
var i = 1
while i < args.count {
    if args[i] == "--app" && i + 1 < args.count { i += 1; appName = args[i] }
    else if args[i] == "--rate" && i + 1 < args.count { i += 1; rate = Int(args[i]) ?? 16000 }
    else if args[i] == "--exclude-pid" && i + 1 < args.count {
        i += 1
        if let p = Int32(args[i]) { pidExcludes.insert(p) }
    }
    else if args[i] == "--exclude-name" && i + 1 < args.count {
        i += 1
        nameExcludes.insert(args[i].lowercased())
    }
    else if args[i] == "--list" { listOnly = true }
    i += 1
}

func log(_ s: String) {
    FileHandle.standardError.write(("[capture-sck] " + s + "\n").data(using: .utf8)!)
}

final class AudioOut: NSObject, SCStreamOutput {
    let out = FileHandle.standardOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sb) else { return }
        var abl = AudioBufferList()
        var bb: CMBlockBuffer?
        let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &bb)
        guard st == noErr else { return }
        for buf in UnsafeMutableAudioBufferListPointer(&abl) {
            guard let data = buf.mData, buf.mDataByteSize > 0 else { continue }
            let ch = max(1, Int(buf.mNumberChannels))
            let n = Int(buf.mDataByteSize) / 4  // SCK entrega Float32
            let frames = n / ch
            let f = data.bindMemory(to: Float.self, capacity: n)
            var pcm = [Int16](repeating: 0, count: frames)
            for j in 0..<frames {
                var acc: Float = 0
                for c in 0..<ch { acc += f[j * ch + c] }
                let v = max(-1.0, min(1.0, acc / Float(ch)))
                pcm[j] = Int16(v * 32767)
            }
            pcm.withUnsafeBufferPointer { out.write(Data(buffer: $0)) }
        }
    }
}

// --list: lista todos os apps disponíveis no SCK (o filtro de apps de voz/mídia é feito no host)
if listOnly {
    let semL = DispatchSemaphore(value: 0)
    var contentL: SCShareableContent?
    var contentErr: Error?
    SCShareableContent.getWithCompletionHandler { c, e in
        contentL = c; contentErr = e; semL.signal()
    }
    semL.wait()
    if let e = contentErr {
        log("erro ao listar apps SCK: \(e.localizedDescription)")
        print("[]")
        exit(0)
    }

    var apps: [[String: String]] = (contentL?.applications ?? [])
        .filter { !$0.bundleIdentifier.isEmpty && !$0.applicationName.isEmpty }
        .map { ["name": $0.applicationName, "bundleId": $0.bundleIdentifier] }

    // Remove duplicatas por bundleId
    var seen = Set<String>()
    apps = apps.filter { seen.insert($0["bundleId"] ?? "").inserted }

    if let data = try? JSONSerialization.data(withJSONObject: apps),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("[]")
    }
    exit(0)
}

// espera o app alvo aparecer (usuário pode iniciar o run ANTES de abrir a call)
var filter: SCContentFilter?
for attempt in 1...30 {
    let sem2 = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var contentErr: Error?
    SCShareableContent.getWithCompletionHandler { c, e in
        content = c; contentErr = e; sem2.signal()
    }
    sem2.wait()
    if let e = contentErr {
        log("erro ao listar conteúdo: \(e.localizedDescription) — permissão de Gravação de Tela?")
        exit(3)
    }
    guard let c = content, let display = c.displays.first else {
        log("sem display/conteúdo disponível")
        exit(3)
    }
    if appName.isEmpty {
        // Nomes são resolvidos AQUI, no momento do filtro — pega processo que subiu depois do start().
        let excluded = c.applications.filter { app in
            if pidExcludes.contains(app.processID) { return true }
            let name = app.applicationName.lowercased()
            let bundle = app.bundleIdentifier.lowercased()
            return nameExcludes.contains { token in name.contains(token) || bundle.contains(token) }
        }
        if !excluded.isEmpty {
            log("ignorando áudio próprio: \(excluded.map { "\($0.applicationName)(\($0.processID))" }.joined(separator: ","))")
        }
        filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        break
    }
    let apps = c.applications.filter {
        $0.applicationName.localizedCaseInsensitiveContains(appName) ||
        $0.bundleIdentifier.localizedCaseInsensitiveContains(appName)
    }
    if !apps.isEmpty {
        filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        break
    }
    if attempt == 1 {
        log("aguardando app '\(appName)' aparecer (30 s)… rodando: \(c.applications.map { $0.applicationName }.joined(separator: ", "))")
    }
    Thread.sleep(forTimeInterval: 1.0)
}
guard let filter else {
    log("app '\(appName)' não apareceu em 30 s")
    exit(2)
}

let cfg = SCStreamConfiguration()
cfg.capturesAudio = true
cfg.sampleRate = rate
cfg.channelCount = 1
cfg.excludesCurrentProcessAudio = true
cfg.width = 2
cfg.height = 2

do {
    let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
    let out = AudioOut()
    try stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "falador.sck.audio"))
    stream.startCapture { err in
        if let err {
            log("falha assíncrona ao iniciar captura: \(err.localizedDescription) — permissão de Gravação de Tela?")
            exit(4)
        }
    }
    log("PRONTO app=\(appName.isEmpty ? "TODOS" : appName) rate=\(rate) — stdout s16le mono")
    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }
    dispatchMain()
} catch {
    log("falha ao iniciar captura: \(error.localizedDescription) — permissão de Gravação de Tela negada?")
    exit(4)
}