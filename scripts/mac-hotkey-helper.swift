import Foundation
import Cocoa
import CoreGraphics
import ApplicationServices

private let leftCmdMask: UInt64 = 0x00000008
private let rightCmdMask: UInt64 = 0x00000010
private let otherModifierMask: UInt64 =
  0x00000002 | // left shift
  0x00000004 | // right shift
  0x00000020 | // left option
  0x00000040 | // right option
  0x00000001 | // left control
  0x00002000   // right control

private func emitJSON(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
        let line = String(data: data, encoding: .utf8) else {
    return
  }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
  fflush(stdout)
}

private func activeDisplays() -> [(id: CGDirectDisplayID, rect: CGRect)] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
    let mainId = CGMainDisplayID()
    return [(mainId, CGDisplayBounds(mainId))]
  }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
    let mainId = CGMainDisplayID()
    return [(mainId, CGDisplayBounds(mainId))]
  }
  return ids.prefix(Int(count)).map { ($0, CGDisplayBounds($0)) }
}

private func displayRect(containing point: CGPoint, displays: [(id: CGDirectDisplayID, rect: CGRect)]) -> CGRect {
  for entry in displays {
    if entry.rect.contains(point) {
      return entry.rect
    }
  }
  return displays.first?.rect ?? CGDisplayBounds(CGMainDisplayID())
}

private func rectDict(_ rect: CGRect) -> [String: Int] {
  [
    "x": Int(rect.origin.x.rounded()),
    "y": Int(rect.origin.y.rounded()),
    "w": max(1, Int(rect.size.width.rounded())),
    "h": max(1, Int(rect.size.height.rounded()))
  ]
}

private func permissionSnapshot(listening: Bool? = nil) -> [String: Any] {
  let accessibility = AXIsProcessTrusted()
  let listenEvent = CGPreflightListenEventAccess()
  let screenRecording = CGPreflightScreenCaptureAccess()
  var out: [String: Any] = [
    "platform": "darwin",
    "accessibility": accessibility,
    "listenEvent": listenEvent,
    "inputMonitoring": accessibility || listenEvent,
    "screenRecording": screenRecording
  ]
  if let listening {
    out["listening"] = listening
  }
  return out
}

private func appIconBase64(for app: NSRunningApplication?) -> String {
  guard let app else { return "" }
  let icon: NSImage
  if let url = app.bundleURL {
    icon = NSWorkspace.shared.icon(forFile: url.path)
  } else if let appIcon = app.icon {
    icon = appIcon
  } else {
    return ""
  }
  let size = NSSize(width: 64, height: 64)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size.width),
    pixelsHigh: Int(size.height),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    return ""
  }
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  if let ctx = NSGraphicsContext(bitmapImageRep: rep) {
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    icon.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1.0)
  }
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
  return png.base64EncodedString()
}

private func inspectCaptureTarget() -> [String: Any] {
  let frontApp = NSWorkspace.shared.frontmostApplication
  let pid = frontApp?.processIdentifier ?? 0
  let appName = frontApp?.localizedName ?? ""
  let bundleId = frontApp?.bundleIdentifier ?? ""
  let lowerBundle = bundleId.lowercased()
  let lowerName = appName.lowercased()
  let isAntigravity = lowerBundle.contains("antigravity") || lowerName.contains("antigravity")

  let displays = activeDisplays()
  let cursorPoint = CGEvent(source: nil)?.location ?? CGPoint.zero
  let cursorDisplay = displayRect(containing: cursorPoint, displays: displays)

  if isAntigravity {
    return [
      "mode": "fullscreen",
      "reason": "antigravity-frontmost",
      "appName": appName,
      "bundleId": bundleId,
      "appIcon": "",
      "isAntigravity": true,
      "displayRect": rectDict(cursorDisplay)
    ]
  }

  let windowList = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  for info in windowList {
    guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid else { continue }
    let layer = (info[kCGWindowLayer as String] as? Int) ?? -1
    if layer != 0 { continue }
    let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1.0
    if alpha <= 0.01 { continue }
    guard let boundsRaw = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsRaw),
          bounds.width >= 80, bounds.height >= 80 else { continue }
    guard let windowNumber = info[kCGWindowNumber as String] as? Int, windowNumber > 0 else { continue }

    let windowName = (info[kCGWindowName as String] as? String) ?? ""
    let winDisplay = displayRect(containing: CGPoint(x: bounds.midX, y: bounds.midY), displays: displays)
    let coversWidth = bounds.width >= winDisplay.width * 0.95
    let coversHeight = bounds.height >= winDisplay.height * 0.92

    // Guard against Finder desktop window slipping into layer 0.
    if lowerBundle == "com.apple.finder" && windowName.isEmpty && coversWidth && coversHeight {
      continue
    }

    let iconBase64 = appIconBase64(for: frontApp)
    if coversWidth && coversHeight {
      return [
        "mode": "fullscreen",
        "reason": "window-fullscreen",
        "windowId": windowNumber,
        "appName": appName,
        "bundleId": bundleId,
        "appIcon": iconBase64,
        "windowTitle": windowName,
        "isAntigravity": false,
        "windowRect": rectDict(bounds),
        "displayRect": rectDict(winDisplay)
      ]
    }

    return [
      "mode": "window",
      "reason": "front-window",
      "windowId": windowNumber,
      "appName": appName,
      "bundleId": bundleId,
      "appIcon": iconBase64,
      "windowTitle": windowName,
      "isAntigravity": false,
      "windowRect": rectDict(bounds),
      "displayRect": rectDict(winDisplay)
    ]
  }

  return [
    "mode": "fullscreen",
    "reason": "no-window",
    "appName": appName,
    "bundleId": bundleId,
    "appIcon": "",
    "isAntigravity": false,
    "displayRect": rectDict(cursorDisplay)
  ]
}

final class DualCommandWatcher {
  private let holdMs: Int
  private var eventTap: CFMachPort?
  private var runLoopSource: CFRunLoopSource?
  private var holdTimer: DispatchSourceTimer?
  private var retryTimer: DispatchSourceTimer?
  private var stdinSource: DispatchSourceRead?
  private var firedForCurrentChord = false
  private var poisonedChord = false
  private var lastFireTime: TimeInterval = 0

  init(holdMs: Int) {
    self.holdMs = max(0, min(1500, holdMs))
  }

  func start() {
    watchParentStdin()
    if !installTap() {
      var snap = permissionSnapshot(listening: false)
      snap["event"] = "ready"
      emitJSON(snap)
      scheduleRetry()
    }
    CFRunLoopRun()
  }

  private func watchParentStdin() {
    let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
    var buf = [UInt8](repeating: 0, count: 256)
    source.setEventHandler {
      let n = read(STDIN_FILENO, &buf, buf.count)
      if n <= 0 {
        exit(0)
      }
    }
    source.resume()
    stdinSource = source
  }

  private func scheduleRetry() {
    retryTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + .seconds(3), repeating: .seconds(3))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      if self.installTap() {
        self.retryTimer?.cancel()
        self.retryTimer = nil
      }
    }
    timer.resume()
    retryTimer = timer
  }

  @discardableResult
  private func installTap() -> Bool {
    if eventTap != nil { return true }
    let mask =
      (CGEventMask(1) << CGEventType.flagsChanged.rawValue) |
      (CGEventMask(1) << CGEventType.keyDown.rawValue)
    let userInfo = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let watcher = Unmanaged<DualCommandWatcher>.fromOpaque(refcon).takeUnretainedValue()
        watcher.handleEvent(type: type, event: event)
        return Unmanaged.passUnretained(event)
      },
      userInfo: userInfo
    ) else {
      return false
    }

    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    eventTap = tap
    runLoopSource = source

    var snap = permissionSnapshot(listening: true)
    snap["event"] = "ready"
    emitJSON(snap)
    return true
  }

  private func cancelHoldTimer() {
    holdTimer?.cancel()
    holdTimer = nil
  }

  private func fireCapture() {
    cancelHoldTimer()
    guard !firedForCurrentChord && !poisonedChord else { return }
    let now = Date().timeIntervalSince1970
    if now - lastFireTime < 0.5 { return }
    firedForCurrentChord = true
    lastFireTime = now

    var payload = inspectCaptureTarget()
    payload["event"] = "capture"
    emitJSON(payload)
  }

  private func handleEvent(type: CGEventType, event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap = eventTap {
        CGEvent.tapEnable(tap: tap, enable: true)
      }
      return
    }

    if type == .keyDown {
      cancelHoldTimer()
      poisonedChord = true
      return
    }

    guard type == .flagsChanged else { return }
    let raw = event.flags.rawValue
    let leftHeld = (raw & leftCmdMask) != 0
    let rightHeld = (raw & rightCmdMask) != 0
    let otherHeld = (raw & otherModifierMask) != 0

    if !leftHeld && !rightHeld {
      cancelHoldTimer()
      firedForCurrentChord = false
      poisonedChord = false
      return
    }

    if otherHeld {
      cancelHoldTimer()
      poisonedChord = true
      return
    }

    if leftHeld && rightHeld {
      if firedForCurrentChord || poisonedChord || holdTimer != nil { return }
      if holdMs == 0 {
        fireCapture()
        return
      }
      let timer = DispatchSource.makeTimerSource(queue: .main)
      timer.schedule(deadline: .now() + .milliseconds(holdMs))
      timer.setEventHandler { [weak self] in
        self?.fireCapture()
      }
      timer.resume()
      holdTimer = timer
    } else {
      cancelHoldTimer()
    }
  }
}

let args = Array(CommandLine.arguments.dropFirst())

if args.contains("--check") {
  emitJSON(permissionSnapshot())
  exit(0)
}

if args.contains("--request-permissions") {
  let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
  _ = CGRequestListenEventAccess()
  _ = CGRequestScreenCaptureAccess()
  emitJSON(permissionSnapshot())
  exit(0)
}

if args.contains("--probe") {
  var payload = inspectCaptureTarget()
  payload["event"] = "probe"
  emitJSON(payload)
  exit(0)
}

var holdMs = 150
if let idx = args.firstIndex(of: "--hold-ms"), idx + 1 < args.count, let parsed = Int(args[idx + 1]) {
  holdMs = parsed
}

let watcher = DualCommandWatcher(holdMs: holdMs)
watcher.start()
