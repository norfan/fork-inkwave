# Build the INKWAVE pad APK with the local Android SDK (no Gradle).
# Requires: Android SDK build-tools 34.0.0 + platforms;android-34, JDK 17.
# Usage: powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # android-pad/
$sdk = 'C:\Users\Administrator\AppData\Local\Android\Sdk'
$bt = Join-Path $sdk 'build-tools\34.0.0'
$plat = Join-Path $sdk 'platforms\android-34\android.jar'
$out = Join-Path $root 'build'
$apk = Join-Path $root 'inkwave-pad.apk'
foreach ($p in @($bt, $plat)) { if (-not (Test-Path $p)) { throw "missing: $p" } }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 0. launcher icons
python (Join-Path $root 'tools\gen_icon.py')
if ($LASTEXITCODE -ne 0) { throw 'gen_icon failed' }

# 1. compile all resources into a single flat container
$aapt2 = Join-Path $bt 'aapt2.exe'
& $aapt2 compile --dir (Join-Path $root 'res') -o (Join-Path $out 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

# 2. link into base.apk (also emits R.java under gen)
& $aapt2 link -o (Join-Path $out 'base.apk') -I $plat `
    --manifest (Join-Path $root 'AndroidManifest.xml') `
    --min-sdk-version 21 --target-sdk-version 34 `
    --java (Join-Path $out 'gen') (Join-Path $out 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# 3. compile Java against android.jar + generated R.java
New-Item -ItemType Directory -Force -Path (Join-Path $out 'classes') | Out-Null
$srcs = (Get-ChildItem (Join-Path $root 'src') -Recurse -Filter *.java).FullName
$cp = "$plat;" + (Join-Path $out 'gen')
& javac -encoding UTF-8 --release 8 -classpath $cp `
    -d (Join-Path $out 'classes') $srcs
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

# 4. dex the classes
New-Item -ItemType Directory -Force -Path (Join-Path $out 'dex') | Out-Null
$dex = (Get-ChildItem (Join-Path $out 'classes') -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& (Join-Path $bt 'd8.bat') --release --lib $plat --output (Join-Path $out 'dex') $dex
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

# 5. merge dex into the apk (aapt2 has no add; append via .NET ZipArchive)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open((Join-Path $out 'base.apk'), [System.IO.Compression.ZipArchiveMode]::Update)
$entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
$stream = $entry.Open()
$bytes = [System.IO.File]::ReadAllBytes((Join-Path $out 'dex\classes.dex'))
$stream.Write($bytes, 0, $bytes.Length)
$stream.Dispose()
$zip.Dispose()

# 6. zipalign (must run BEFORE signing; an unaligned APK can be rejected by some installers as "invalid package")
& (Join-Path $bt 'zipalign.exe') -f 4 (Join-Path $out 'base.apk') (Join-Path $out 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

# 7. sign with a fresh debug keystore
$ks = Join-Path $out 'pad.keystore'
if (-not (Test-Path $ks)) {
    & keytool -genkeypair -v -keystore $ks -storepass inkwave -alias pad -keypass inkwave `
        -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=INKWAVE Pad, OU=Dev, O=INKWAVE, L=City, ST=State, C=CN'
    if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
& (Join-Path $bt 'apksigner.bat') sign --ks $ks --ks-pass pass:inkwave --key-pass pass:inkwave `
    --out $apk (Join-Path $out 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Write-Output ("APK: " + $apk)
& (Join-Path $bt 'apksigner.bat') verify --print-certs $apk | Select-Object -First 6
