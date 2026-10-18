#!/usr/bin/env python3
"""Deterministic, dependency-free generator for this small Xcode project."""
from hashlib import sha1
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT / "TadaimaScan.xcodeproj"


def uid(name):
    return sha1(("tadaima-scan:" + name).encode()).hexdigest()[:24].upper()


def main():
    sources = sorted(path.name for path in (ROOT / "TadaimaScan").glob("*.swift"))
    records = []

    def record(name, body):
        records.append(f"\t\t{uid(name)} /* {name} */ = {{ {body} }};")

    for source in sources:
        record(source + " ref", f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{source}"; sourceTree = "<group>";')
        record(source + " build", f'isa = PBXBuildFile; fileRef = {uid(source + " ref")};')
    record("Info.plist ref", 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";')
    record("RoomPlan ref", 'isa = PBXFileReference; lastKnownFileType = wrapper.framework; path = System/Library/Frameworks/RoomPlan.framework; sourceTree = SDKROOT;')
    record("RoomPlan build", f'isa = PBXBuildFile; fileRef = {uid("RoomPlan ref")};')
    record("App product", 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = TadaimaScan.app; sourceTree = BUILT_PRODUCTS_DIR;')
    source_refs = ", ".join(uid(source + " ref") for source in sources)
    source_builds = ", ".join(uid(source + " build") for source in sources)
    record("Sources group", f'isa = PBXGroup; children = ({source_refs}, {uid("Info.plist ref")}); path = TadaimaScan; sourceTree = "<group>";')
    record("Products group", f'isa = PBXGroup; children = ({uid("App product")}); name = Products; sourceTree = "<group>";')
    record("Frameworks group", f'isa = PBXGroup; children = ({uid("RoomPlan ref")}); name = Frameworks; sourceTree = "<group>";')
    record("Main group", f'isa = PBXGroup; children = ({uid("Sources group")}, {uid("Frameworks group")}, {uid("Products group")}); sourceTree = "<group>";')
    record("Sources phase", f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({source_builds}); runOnlyForDeploymentPostprocessing = 0;')
    record("Frameworks phase", f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({uid("RoomPlan build")}); runOnlyForDeploymentPostprocessing = 0;')
    record("Resources phase", 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
    for kind in ("project", "target"):
        for configuration in ("Debug", "Release"):
            settings = 'CLANG_ENABLE_MODULES = YES; SWIFT_VERSION = 6.0; SWIFT_STRICT_CONCURRENCY = complete; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos;'
            if kind == "target":
                settings += ' CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = ""; PRODUCT_BUNDLE_IDENTIFIER = dev.tadaima.scan; PRODUCT_NAME = "$(TARGET_NAME)"; INFOPLIST_FILE = TadaimaScan/Info.plist; GENERATE_INFOPLIST_FILE = NO; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; TARGETED_DEVICE_FAMILY = 1; SUPPORTS_MACCATALYST = NO; ENABLE_USER_SCRIPT_SANDBOXING = YES;'
            if configuration == "Debug":
                settings += ' SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;'
            else:
                settings += ' SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
            record(kind + " " + configuration, f'isa = XCBuildConfiguration; buildSettings = {{ {settings} }}; name = {configuration};')
        record(kind + " configurations", f'isa = XCConfigurationList; buildConfigurations = ({uid(kind + " Debug")}, {uid(kind + " Release")}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
    record("App target", f'isa = PBXNativeTarget; buildConfigurationList = {uid("target configurations")}; buildPhases = ({uid("Sources phase")}, {uid("Frameworks phase")}, {uid("Resources phase")}); buildRules = (); dependencies = (); name = TadaimaScan; productName = TadaimaScan; productReference = {uid("App product")}; productType = "com.apple.product-type.application";')
    record("Project", f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2700; TargetAttributes = {{ {uid("App target")} = {{ CreatedOnToolsVersion = 27.0; }}; }}; }}; buildConfigurationList = {uid("project configurations")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = {uid("Main group")}; productRefGroup = {uid("Products group")}; projectDirPath = ""; projectRoot = ""; targets = ({uid("App target")});')
    PROJECT.mkdir(exist_ok=True)
    (PROJECT / "project.pbxproj").write_text('// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n' + "\n".join(records) + '\n\t};\n\trootObject = ' + uid("Project") + ';\n}\n')
    scheme = PROJECT / "xcshareddata/xcschemes"
    scheme.mkdir(parents=True, exist_ok=True)
    reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid("App target")}" BuildableName="TadaimaScan.app" BlueprintName="TadaimaScan" ReferencedContainer="container:TadaimaScan.xcodeproj"/>'
    (scheme / "TadaimaScan.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
    print(PROJECT)


if __name__ == "__main__":
    main()
