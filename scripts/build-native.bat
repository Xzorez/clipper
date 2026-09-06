@echo off
REM Compila el capturador de sonido del sistema.
REM
REM Se compila una sola vez y el ejecutable viaja dentro de la aplicacion, como
REM ffmpeg.exe: quien la instala no necesita ningun compilador ni instalar nada
REM aparte.
setlocal
set VS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VS%" (
  echo No se ha encontrado Visual Studio Build Tools 2022.
  exit /b 1
)
call "%VS%" >nul
if errorlevel 1 exit /b 1

set ROOT=%~dp0..
if not exist "%ROOT%\resources\native" mkdir "%ROOT%\resources\native"

cl /nologo /O2 /EHsc /std:c++17 /MT ^
   "%ROOT%\native\loopback\loopback.cpp" ^
   /Fe:"%ROOT%\resources\native\clipper-loopback.exe" ^
   /Fo:"%TEMP%\clipper-loopback.obj" ^
   /link ole32.lib
exit /b %errorlevel%
