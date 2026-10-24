@echo off
set "A=%ProgramFiles%\AutoHotkey"
"%A%\Compiler\Ahk2Exe.exe" /in "%~dp0Firefox AHK Receiver.ahk" /out "%~dp0Firefox AHK Receiver Companion Installer Uninstaller.exe" /base "%A%\v2\AutoHotkey64.exe"
if errorlevel 1 echo Build failed. Needs AutoHotkey v2 with Ahk2Exe installed.
