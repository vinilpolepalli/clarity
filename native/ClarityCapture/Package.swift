// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClarityCapture",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ClarityCapture", targets: ["ClarityCapture"])],
    targets: [.executableTarget(name: "ClarityCapture")],
    swiftLanguageModes: [.v5]
)
