@echo off
REM ===========================================================================
REM Build an Electron-compatible, self-contained lbugjs.node for Windows.
REM Unified script for BOTH target architectures (replaces build-win-arm64.bat).
REM
REM   build-win.bat            -> builds amd64 (default)
REM   build-win.bat amd64      -> builds win32-amd64
REM   build-win.bat arm64      -> builds win32-arm64
REM
REM What it guarantees
REM   * Electron-compatible: delay-loads node.exe (loads under Node AND Electron).
REM   * Self-contained: STATIC CRT (/MT) by default, so the .node does NOT depend
REM     on VCRUNTIME140.dll / MSVCP140.dll (the VC++ Redistributable). Those are
REM     absent on clean machines (esp. Windows-on-ARM), which makes a /MD build
REM     fail in process.dlopen. Set LBUG_CRT=MD to opt back into the dynamic CRT.
REM   * Cross or native: picks the right MSVC toolchain from the host vs target
REM     arch (e.g. amd64_arm64 cross on an x64 box, or native amd64/arm64).
REM   * Logs everything to .\build-<arch>.log at the repo root.
REM
REM Prerequisites (one-time)
REM   1. Upstream source cloned with the addon submodule + npm deps:
REM        set LBUG_SUBMODULES=tools/nodejs_api
REM        yarn clone:source
REM        pushd lbug-src\tools\nodejs_api ^&^& npm install ^&^& popd
REM   2. Visual Studio 2022+ with the C++ tools for the TARGET arch:
REM        amd64 -> Microsoft.VisualStudio.Component.VC.Tools.x86.x64 (default C++)
REM        arm64 -> Microsoft.VisualStudio.Component.VC.Tools.ARM64   (cross tools)
REM      If the required component is missing the script prints the install line.
REM
REM Optional env
REM   LBUG_CRT=MD            use the dynamic CRT (/MD) instead of static (/MT)
REM   LBUG_VSINSTALL=<path>  pin the VS install (skip vswhere auto-detect); useful
REM                          to avoid a prerelease toolset whose arm64 cross
REM                          compiler is unstable (VS 18 / MSVC 14.50 crashed where
REM                          BuildTools 2022 / 14.44 is fine).
REM
REM Error-handling uses goto labels (not inline parenthesized blocks): caret /
REM nested-paren tricks inside if-blocks are a known cmd.exe parsing hazard.
REM ===========================================================================

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
set "NODEJS_API=%REPO_ROOT%\lbug-src\tools\nodejs_api"

REM --- parse + normalize the target arch (default amd64) ---
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=amd64"
if /i "%TARGET%"=="x64" set "TARGET=amd64"
if /i "%TARGET%"=="x86_64" set "TARGET=amd64"
if /i "%TARGET%"=="aarch64" set "TARGET=arm64"
if /i "%TARGET%"=="amd64" goto arch_ok
if /i "%TARGET%"=="arm64" goto arch_ok
echo ERROR: unknown target arch "%TARGET%" - use "amd64" or "arm64".
exit /b 1
:arch_ok

REM --- redirect all output to .\build-<arch>.log (re-exec self once) ---
if defined LBUG_BUILD_LOGGING goto body
set "LBUG_BUILD_LOGGING=1"
echo Building win32-%TARGET%; logging to "%REPO_ROOT%\build-%TARGET%.log" ...
call "%~f0" %* > "%REPO_ROOT%\build-%TARGET%.log" 2>&1
set "RC=%errorlevel%"
echo Done (exit %RC%). Log: "%REPO_ROOT%\build-%TARGET%.log"
exit /b %RC%

:body
echo === ladybug-lite: build Electron-compatible win32-%TARGET% ===
echo REPO_ROOT = %REPO_ROOT%

if not exist "%NODEJS_API%\CMakeLists.txt" goto err_noclone

REM --- CRT: static (/MT) by default; LBUG_CRT=MD switches to dynamic (/MD) ---
set "RUNTIME=MultiThreaded"
set "CRTDESC=static /MT (self-contained)"
if /i "%LBUG_CRT%"=="MD" set "RUNTIME=MultiThreadedDLL"
if /i "%LBUG_CRT%"=="MD" set "CRTDESC=dynamic /MD (needs VC++ redist)"
if /i "%LBUG_CRT%"=="dynamic" set "RUNTIME=MultiThreadedDLL"
if /i "%LBUG_CRT%"=="dynamic" set "CRTDESC=dynamic /MD (needs VC++ redist)"
echo CRT = %CRTDESC%

REM --- map target -> cmake-js arch + required VS component ---
if /i "%TARGET%"=="arm64" goto cfg_arm64
set "CMJS_ARCH=x64"
set "VC_COMPONENT=Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
goto cfg_done
:cfg_arm64
set "CMJS_ARCH=arm64"
set "VC_COMPONENT=Microsoft.VisualStudio.Component.VC.Tools.ARM64"
:cfg_done

REM --- host arch -> vcvarsall arch (native "amd64"/"arm64" or cross "host_target") ---
set "HOSTVC=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HOSTVC=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "HOSTVC=arm64"
if /i "%HOSTVC%"=="%TARGET%" goto vc_native
set "VCARCH=%HOSTVC%_%TARGET%"
goto vc_done
:vc_native
set "VCARCH=%TARGET%"
:vc_done
echo Toolchain: host=%HOSTVC% target=%TARGET% -> vcvarsall %VCARCH%

REM --- locate a VS install that has the C++ tools for this target, via vswhere ---
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto err_novswhere
set "VSINSTALL=%LBUG_VSINSTALL%"
if defined VSINSTALL goto have_vsinstall
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires %VC_COMPONENT% -property installationPath`) do set "VSINSTALL=%%I"
:have_vsinstall
if not defined VSINSTALL goto err_nocomponent
echo VS install: %VSINSTALL%

set "VCVARSALL=%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARSALL%" goto err_novcvars

echo === Setting up MSVC environment (%VCARCH%) ===
call "%VCVARSALL%" %VCARCH%
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

echo === Pointing cmake-js at the win-%TARGET% node.lib ===
call node "%SCRIPT_DIR%setCmakeJsArch.js" "%NODEJS_API%" %CMJS_ARCH%
if errorlevel 1 goto err_setarch

echo === Making Windows SDK arch macro + pcg endianness arch-aware ===
call node "%SCRIPT_DIR%patchWinArchMacro.js" "%REPO_ROOT%\lbug-src"
if errorlevel 1 goto err_archmacro

cd /d "%REPO_ROOT%\lbug-src"
if errorlevel 1 goto err_cd

echo ===== CONFIGURE (%TARGET%, %CRTDESC%) =====
cmake -B build/%TARGET% -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=%RUNTIME% -DBUILD_NODEJS=TRUE -DBUILD_SHELL=FALSE -DBUILD_TESTS=FALSE -DBUILD_BENCHMARK=FALSE .
if errorlevel 1 goto err_configure

echo ===== BUILD (%TARGET%) =====
cmake --build build/%TARGET% --config Release
if errorlevel 1 goto err_build

set "BUILT=%REPO_ROOT%\lbug-src\tools\nodejs_api\build\lbugjs.node"
if not exist "%BUILT%" goto err_nobinary

set "OUT=%REPO_ROOT%\prebuilt\lbugjs-win32-%TARGET%.node"
if not exist "%REPO_ROOT%\prebuilt" mkdir "%REPO_ROOT%\prebuilt"
copy /y "%BUILT%" "%OUT%" >nul
echo ===== RESULT =====
echo Built: %OUT%
node -e "console.log('size =', require('fs').statSync(process.argv[1]).size)" "%OUT%"

echo === Verifying Electron compatibility (delay-load + arch) ===
call node "%SCRIPT_DIR%check-electron-compat.js" "%OUT%"
if errorlevel 1 goto err_incompat

echo BUILD_OK (win32-%TARGET%, %CRTDESC%)
exit /b 0

:err_noclone
echo ERROR: %NODEJS_API% not found. Clone the upstream source first:
echo          set LBUG_SUBMODULES=tools/nodejs_api ^&^& yarn clone:source
echo          pushd lbug-src\tools\nodejs_api ^&^& npm install ^&^& popd
exit /b 1

:err_novswhere
echo ERROR: vswhere.exe not found at "%VSWHERE%".
echo        Install Visual Studio / Build Tools 2022 or newer.
exit /b 1

:err_nocomponent
echo ERROR: No Visual Studio install with the C++ tools for %TARGET% was found.
echo        Required component: %VC_COMPONENT%
echo.
echo        Install it without disturbing other toolchains, for example:
echo          winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add %VC_COMPONENT%"
echo        or add it via the Visual Studio Installer ("Modify"). Or set
echo        LBUG_VSINSTALL to an install path that already has it.
exit /b 2

:err_novcvars
echo ERROR: vcvarsall.bat not found at "%VCVARSALL%".
exit /b 2

:err_vcvars
echo ERROR: vcvarsall %VCARCH% failed.
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
