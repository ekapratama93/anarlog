import BackgroundTasks
import ExpoModulesCore
import UIKit

public class AnarlogBackgroundSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AnarlogBackgroundSync")

    OnCreate {
      DispatchQueue.main.async {
        BackgroundSyncService.shared.activate()
      }
    }

    AsyncFunction("setEnabled") { (enabled: Bool) in
      BackgroundSyncService.shared.setEnabled(enabled)
    }.runOnQueue(.main)

    AsyncFunction("setPendingWork") { (remaining: Int, subtitle: String) in
      BackgroundSyncService.shared.setPendingWork(
        remaining: remaining,
        subtitle: subtitle
      )
    }.runOnQueue(.main)

    AsyncFunction("finishBackgroundFlush") {
      BackgroundSyncService.shared.finishBackgroundFlush()
    }.runOnQueue(.main)
  }
}

// All state is confined to the main queue.
private final class BackgroundSyncService {
  static let shared = BackgroundSyncService()

  private let title = "Syncing Anarlog"
  private var observers: [NSObjectProtocol] = []
  private var enabled = false
  private var remaining = 0
  private var subtitle = "Syncing notes"
  private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
  private var flushPending = false
  private var continuedTask: BGTask?
  private var submittedIdentifier: String?

  func activate() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.appWillResignActive()
      },
      center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.appDidEnterBackground()
      },
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.appDidBecomeActive()
      },
    ]
  }

  func setEnabled(_ enabled: Bool) {
    self.enabled = enabled
    guard !enabled else { return }
    remaining = 0
    flushPending = false
    cancelSubmittedRequest()
    finishContinuedTask(success: true)
    endBackgroundTime()
  }

  func setPendingWork(remaining: Int, subtitle: String) {
    self.remaining = max(0, remaining)
    self.subtitle = subtitle
    if self.remaining == 0 {
      cancelSubmittedRequest()
      finishContinuedTask(success: true)
      if !flushPending { endBackgroundTime() }
      return
    }
    reportContinuedTaskProgress()
  }

  func finishBackgroundFlush() {
    flushPending = false
    if remaining == 0 { endBackgroundTime() }
  }

  // Continued processing requests must be submitted while the app is still
  // in the foreground, so this runs before the app is backgrounded.
  private func appWillResignActive() {
    guard enabled, remaining > 0 else { return }
    if #available(iOS 26.0, *) {
      submitContinuedTask()
    }
  }

  private func appDidEnterBackground() {
    guard enabled else { return }
    flushPending = true
    beginBackgroundTime()
  }

  private func appDidBecomeActive() {
    flushPending = false
    endBackgroundTime()
  }

  private func beginBackgroundTime() {
    guard backgroundTaskId == .invalid else { return }
    backgroundTaskId = UIApplication.shared.beginBackgroundTask(
      withName: "AnarlogSync"
    ) { [weak self] in
      self?.endBackgroundTime()
    }
  }

  private func endBackgroundTime() {
    guard backgroundTaskId != .invalid else { return }
    let taskId = backgroundTaskId
    backgroundTaskId = .invalid
    UIApplication.shared.endBackgroundTask(taskId)
  }

  @available(iOS 26.0, *)
  private func submitContinuedTask() {
    guard
      continuedTask == nil,
      submittedIdentifier == nil,
      let bundleIdentifier = Bundle.main.bundleIdentifier
    else { return }

    let identifier = "\(bundleIdentifier).sync.\(UUID().uuidString)"
    let registered = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: identifier,
      using: .main
    ) { [weak self] task in
      guard let self, let task = task as? BGContinuedProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      self.startContinuedTask(task)
    }
    guard registered else { return }

    let request = BGContinuedProcessingTaskRequest(
      identifier: identifier,
      title: title,
      subtitle: subtitle
    )
    do {
      try BGTaskScheduler.shared.submit(request)
      submittedIdentifier = identifier
    } catch {
      submittedIdentifier = nil
    }
  }

  private func cancelSubmittedRequest() {
    guard let identifier = submittedIdentifier else { return }
    submittedIdentifier = nil
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
  }

  @available(iOS 26.0, *)
  private func startContinuedTask(_ task: BGContinuedProcessingTask) {
    if submittedIdentifier == task.identifier { submittedIdentifier = nil }
    guard enabled, remaining > 0 else {
      task.setTaskCompleted(success: true)
      return
    }
    continuedTask = task
    task.expirationHandler = { [weak self] in
      DispatchQueue.main.async {
        self?.finishContinuedTask(success: false)
      }
    }
    task.progress.totalUnitCount = Int64(remaining)
    task.progress.completedUnitCount = 0
    task.updateTitle(title, subtitle: subtitle)
  }

  private func reportContinuedTaskProgress() {
    guard #available(iOS 26.0, *),
      let task = continuedTask as? BGContinuedProcessingTask
    else { return }
    let progress = task.progress
    let outstanding = Int64(remaining)
    progress.totalUnitCount = max(
      progress.totalUnitCount,
      progress.completedUnitCount + outstanding
    )
    progress.completedUnitCount = progress.totalUnitCount - outstanding
    task.updateTitle(title, subtitle: subtitle)
  }

  private func finishContinuedTask(success: Bool) {
    guard let task = continuedTask else { return }
    continuedTask = nil
    if #available(iOS 26.0, *), success,
      let continued = task as? BGContinuedProcessingTask
    {
      continued.progress.completedUnitCount = continued.progress.totalUnitCount
    }
    task.setTaskCompleted(success: success)
  }
}
