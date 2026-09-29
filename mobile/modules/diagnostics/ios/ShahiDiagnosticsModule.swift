import ExpoModulesCore

public class ShahiDiagnosticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShahiDiagnostics")
    Function("isEnabled") {
      UserDefaults.standard.object(forKey: "shahi.diagnostics.enabled") as? Bool ?? true
    }
    Function("setEnabled") { (enabled: Bool) in
      UserDefaults.standard.set(enabled, forKey: "shahi.diagnostics.enabled")
      NotificationCenter.default.post(name: Notification.Name("shahi.diagnostics.changed"), object: nil)
    }
  }
}
