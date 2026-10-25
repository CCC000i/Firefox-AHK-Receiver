@echo off
set "A=%ProgramFiles%\AutoHotkey"
"%A%\Compiler\Ahk2Exe.exe" /in "%~dp0Firefox_AHK_Receiver_Companion_Installer_Uninstaller.ahk" /out "%~dp0Firefox_AHK_Receiver_Companion_Installer_Uninstaller.exe" /base "%A%\v2\AutoHotkey64.exe"
if errorlevel 1 echo Build failed. Needs AutoHotkey v2 with Ahk2Exe installed.
