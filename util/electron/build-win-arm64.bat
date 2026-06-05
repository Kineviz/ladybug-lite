@echo off
REM ===========================================================================
REM Cross-compile the Electron-compatible win32-ARM64 lbugjs.node ON a win32-x64
REM host, mirroring `make nodejs` (cmake -DBUILD_NODEJS=TRUE, Ninja) but with the
REM amd64_arm64 MSVC cross toolchain.
REM
REM Prerequisites (one-time):
REM   1. A clone of the upstream ladybug source at the pinned version, with the
REM      tools/nodejs_api submodule and its npm deps installed. From repo root:
REM        set LBUG_SUBMODULES=tools/nodejs_api
REM        yarn clone:source
REM        then: cd lbug-src\tools\nodejs_api  and  npm install
REM   2. Visual Studio (2022 or 2026) with the ARM64 C++ cross build tools,
REM      component id: Microsoft.VisualStudio.Component.VC.Tools.ARM64
REM      Install it without touching the rest of VS (see the message this script
REM      prints if the component is missing), or add it via the VS Installer.
REM
REM The produced binary's PE imports "node.exe" as a DELAY import (via the
REM delay-load patch), so it loads under BOTH Node and Electron, same as amd64.
REM
REM Error-handling uses goto labels (not inline parenthesized blocks) on purpose:
REM caret-escaped parens inside if-blocks are a known cmd.exe parsing hazard.
REM ===========================================================================

REM --- repo root is two levels up from this script (util\electron\) ---
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
set "NODEJS_API=%REPO_ROOT%\lbug-src\tools\nodejs_api"

echo === ladybug-lite: cross-compile win32-arm64 (host=amd64) ===
echo REPO_ROOT = %REPO_ROOT%

if not exist "%NODEJS_API%\CMakeLists.txt" goto err_noclone

REM --- locate a VS install that has the x64 to arm64 cross tools, via vswhere ---
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto err_novswhere

set "VSINSTALL="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath`) do set "VSINSTALL=%%I"
if not defined VSINSTALL goto err_noarm64
echo VS with ARM64 cross tools: %VSINSTALL%

set "VCVARSALL=%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARSALL%" goto err_novcvars

echo === Setting up amd64_arm64 cross environment ===
call "%VCVARSALL%" amd64_arm64
if errorlevel 1 goto err_vcvars

REM vcvars adds cl but not the VS-bundled CMake/Ninja; add them to PATH.
set "PATH=%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"

echo --- tool locations ---
where cl
where ninja
where cmake
where node

echo === Applying Electron delay-load patch (idempotent) ===
call node "%SCRIPT_DIR%patchWinDelayLoad.js" "%NODEJS_API%"
if errorlevel 1 goto err_patch

echo === Pointing cmake-js at the win-arm64 node.lib (cross target) ===
call node "%SCRIPT_DIR%setCmakeJsArch.js" "%NODEJS_API%" arm64
if errorlevel 1 goto err_setarch

echo === Making the Windows SDK arch macro arch-aware (_ARM64_ not _AMD64_) ===
call node "%SCRIPT_DIR%patchWinArchMacro.js" "%REPO_ROOT%\lbug-src"
if errorlevel 1 goto err_archmacro

cd /d "%REPO_ROOT%\lbug-src"
if errorlevel 1 goto err_cd

echo ===== CONFIGURE (arm64) =====
cmake -B build/arm64 -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_NODEJS=TRUE -DBUILD_SHELL=FALSE -DBUILD_TESTS=FALSE -DBUILD_BENCHMARK=FALSE .
if errorlevel 1 goto err_configure

echo ===== BUILD (arm64) =====
cmake --build build/arm64 --config Release
if errorlevel 1 goto err_build

set "BUILT=%REPO_ROOT%\lbug-src\tools\nodejs_api\build\lbugjs.node"
if not exist "%BUILT%" goto err_nobinary

set "OUT=%REPO_ROOT%\prebuilt\lbugjs-win32-arm64.node"
if not exist "%REPO_ROOT%\prebuilt" mkdir "%REPO_ROOT%\prebuilt"
copy /y "%BUILT%" "%OUT%" >nul
echo ===== RESULT =====
echo Built: %OUT%
node -e "console.log('size =', require('fs').statSync(process.argv[1]).size)" "%OUT%"

echo === Verifying it is a win32-arm64 PE with node.exe as a DELAY import ===
call node "%SCRIPT_DIR%check-electron-compat.js" "%OUT%"
if errorlevel 1 goto err_incompat

echo BUILD_OK
exit /b 0

:err_noclone
echo ERROR: %NODEJS_API% not found.
echo        Clone the upstream source first (see the header of this script).
exit /b 1

:err_novswhere
echo ERROR: vswhere.exe not found at "%VSWHERE%".
echo        Install Visual Studio / Build Tools 2022 or newer.
exit /b 1

:err_noarm64
echo ERROR: No Visual Studio install with the ARM64 C++ cross build tools was found.
echo        Required component: Microsoft.VisualStudio.Component.VC.Tools.ARM64
echo.
echo        Install it without disturbing the amd64 toolchain, for example:
echo          winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Component.VC.Tools.ARM64"
echo        or add it via the Visual Studio Installer ("Modify").
exit /b 2

:err_novcvars
echo ERROR: vcvarsall.bat not found at "%VCVARSALL%".
exit /b 2

:err_vcvars
echo ERROR: vcvarsall amd64_arm64 failed.
exit /b 2

:err_patch
echo ERROR: delay-load patch failed.
exit /b 3

:err_setarch
echo ERROR: setCmakeJsArch failed.
exit /b 3

:err_archmacro
echo ERROR: patchWinArchMacro failed.
exit /b 3

:err_cd
echo ERROR: cd lbug-src failed.
exit /b 3

:err_configure
echo ERROR: cmake configure failed.
exit /b 4

:err_build
echo ERROR: cmake build failed.
exit /b 5

:err_nobinary
echo ERROR: %BUILT% missing.
exit /b 6

:err_incompat
echo WARN: Electron-compat check FAILED (see above).
exit /b 7
