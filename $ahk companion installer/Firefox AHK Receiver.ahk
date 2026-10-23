#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon

; Compiled, double-click = installer/uninstaller (per-user, no admin).
; Started by Firefox (native messaging) = helper: one per Firefox process, lives and dies with it.
; Hotkeys only fire while the owning Firefox process has the active window, so multiple profiles work.
; Protocol (4-byte length + UTF-8 JSON):
;   add-on -> helper: {"id":N,"cmd":"read"} | {"id":N,"cmd":"write","text":"<ini>"}
;   helper -> add-on: {"id":N,"ok":true,...} | {"cmd":"open","url":"..."} | {"cmd":"options"} | {"cmd":"focusnew"}

ID := "ahkreceiver@ccc000i.addon"
NAME := "Firefox AHK Receiver"
REGKEY := "HKCU\Software\Mozilla\NativeMessagingHosts\ahk_receiver"
DEFAULT_INI := "background = #000`r`nactive_font = #E0E0E0`r`ncleared_font = #555`r`noptions_key = !o`r`nlist = `"`r`n(`r`n)`""
ini := A_ScriptDir "\" NAME ".ini"
ownerPid := 0, ownerExe := "", ownerArgs := "", hIn := 0, hOut := 0
last := Chr(1), active := Map()   ; Chr(1): never equals real file text

if IsHostLaunch()
    StartHost()
else {
    Setup()
    ExitApp
}

IsHostLaunch() {
    for a in A_Args
        if a = ID
            return true
    return false
}

; ---------------- Installer ----------------

Setup() {
    dir := EnvGet("LOCALAPPDATA") "\" NAME
    cur := ""
    try cur := RegRead(REGKEY)
    if cur != "" {
        r := MsgBox(NAME " is installed.`n`nYes: reinstall / update`nNo: uninstall", NAME, "YesNoCancel Iconi")
        if r = "Cancel"
            return
        if r = "No" {
            try RegDelete(REGKEY)
            try DirDelete(dir, true)
            MsgBox(DirExist(dir) ? "Unregistered. Some files are still in use; delete them after closing Firefox:`n" dir : "Uninstalled.", NAME, "Iconi")
            return
        }
    }
    exe := dir "\" NAME ".exe", script := dir "\" NAME ".ahk"
    bat := dir "\" NAME ".bat", manifest := dir "\" NAME ".json"
    iniDst := dir "\" NAME ".ini"
    try {
        DirCreate(dir)
        if A_IsCompiled {
            if A_ScriptFullPath != exe
                FileCopy(A_ScriptFullPath, exe, true)
            target := exe
        } else {
            if A_ScriptFullPath != script
                FileCopy(A_ScriptFullPath, script, true)
            WriteFile(bat, '@echo off`r`n"' A_AhkPath '" "' script '" %*`r`n', "CP0")
            target := bat
        }
        WriteFile(manifest,
            '{`n  "name": "ahk_receiver",`n  "description": "Firefox AHK Receiver",`n'
            . '  "path": "' StrReplace(target, "\", "\\") '",`n  "type": "stdio",`n'
            . '  "allowed_extensions": ["' ID '"]`n}`n', "UTF-8-RAW")
        RegWrite(manifest, "REG_SZ", REGKEY)
        if !FileExist(iniDst)
            WriteFile(iniDst, DEFAULT_INI, "UTF-8-RAW")
    } catch as e {
        MsgBox("Install failed: " e.Message "`n`nIf Firefox is running, close it and run this again.", NAME, "Iconx")
        return
    }
    MsgBox("Installed to:`n" dir "`n`nThe add-on connects within ~15 s, no restart needed.", NAME, "Iconi")
}

WriteFile(path, text, enc) {
    f := FileOpen(path, "w", enc)
    f.Write(text)
    f.Close()
}

; ---------------- Helper ----------------

StartHost() {
    global ownerPid, ownerExe, ownerArgs, hIn, hOut
    info := ProcInfo(ProcessExist())
    info := info ? ProcInfo(info.ParentProcessId) : ""
    while info && info.Name = "cmd.exe"      ; skip the .bat wrapper of the uncompiled variant
        info := ProcInfo(info.ParentProcessId)
    if !info
        ExitApp
    ownerPid := info.ProcessId
    ownerExe := info.ExecutablePath
    cmd := ""
    try cmd := info.CommandLine
    ; Keep the profile of this Firefox for about:/file: URLs that only the command line can open
    if RegExMatch(cmd, 'i)\s--?(profile|P)\s+(?!-)("[^"]*"|\S+)', &m)
        ownerArgs := " -" m[1] " " m[2]
    hIn := DllCall("GetStdHandle", "Int", -10, "Ptr")
    hOut := DllCall("GetStdHandle", "Int", -11, "Ptr")
    SetTimer(Poll, 50)
    SetTimer(Watch, 1000)
    Watch()
}

ProcInfo(pid) {
    try for p in ComObjGet("winmgmts:").ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" pid)
        return p
    return ""
}

FocusCheck(*) => WinActive("ahk_pid " ownerPid)

; Drains requests from Firefox without blocking hotkeys. Exits when the pipe closes.
Poll() {
    Critical
    avail := 0
    Loop {
        if !DllCall("PeekNamedPipe", "Ptr", hIn, "Ptr", 0, "UInt", 0, "Ptr", 0, "UInt*", &avail, "Ptr", 0)
            ExitApp
        if avail < 4
            return
        id := 0
        try {
            msg := ReadMessage()
            if msg = ""
                ExitApp
            if RegExMatch(msg, '^\s*\{\s*"id"\s*:\s*(\d+)', &im)
                id := im[1]
            body := Handle(msg)
        } catch as e
            body := '"ok":false,"error":"' JsonEscape(e.Message) '"'
        WriteMessage('{"id":' id ',' body '}')
    }
}

Handle(msg) {
    if !RegExMatch(msg, '^\s*\{\s*"id"\s*:\s*\d+\s*,\s*"cmd"\s*:\s*"(\w+)"\s*(?:,\s*"text"\s*:\s*"((?:[^"\\]++|\\.)*+)"\s*)?\}\s*$', &m)
        throw Error("Unrecognised request.")
    if m[1] = "read" {
        txt := FileExist(ini) ? FileRead(ini, "UTF-8") : ""
        return '"ok":true,"text":"' JsonEscape(txt) '"'
    }
    if m[1] != "write" || !m.Pos(2)
        throw Error("Unrecognised request.")
    ; temp file + move, so Watch never reads half a file
    tmp := ini ".tmp"
    WriteFile(tmp, JsonUnescape(m[2]), "UTF-8-RAW")
    Loop 10 {
        try {
            FileMove(tmp, ini, true)
            Watch()
            return '"ok":true'
        }
        Sleep(50)
    }
    try FileDelete(tmp)
    throw Error("Could not replace the ini (file locked?).")
}

; Compares content rather than mtime (1 s resolution)
Watch() {
    global last
    txt := ""
    if FileExist(ini) {
        try txt := FileRead(ini, "UTF-8")
        catch
            return
    }
    if txt == last
        return
    last := txt
    Apply(txt)
}

Apply(txt) {
    optKey := "", binds := Map(), inList := false
    for line in StrSplit(txt, "`n", "`r") {
        t := Trim(line)
        if inList {
            if SubStr(t, 1, 1) = ")"
                inList := false
            else if RegExMatch(t, "^(.+?):(.+)$", &m)
                binds[m[1]] := m[2]
        } else if RegExMatch(t, "i)^options_key\s*=\s*(.+)$", &o)
            optKey := o[1]
        else if RegExMatch(t, "i)^list\s*=")
            inList := true
    }
    HotIf(FocusCheck)
    for k in active
        try Hotkey(k, "Off")
    active.Clear()
    for k, u in binds
        try {
            Hotkey(k, oURL.Bind(u), "On")
            active[k] := 1
        }
    if optKey != ""
        try {
            Hotkey(optKey, oOptions, "On")
            active[optKey] := 1
        }
    HotIf()
}

oURL(url, *) {
    ; Extensions can't open these schemes, so use this Firefox's command line
    if RegExMatch(url, "i)^(about|chrome|file|resource|view-source|jar):") {
        if ownerExe != "" && !InStr(url, '"') {
            WriteMessage('{"cmd":"focusnew"}')
            try Run('"' ownerExe '"' ownerArgs ' -new-tab "' url '"')
        }
        return
    }
    WriteMessage('{"cmd":"open","url":"' JsonEscape(url) '"}')
}

oOptions(*) => WriteMessage('{"cmd":"options"}')

ReadMessage() {
    lenBuf := Buffer(4)
    if !ReadExact(lenBuf, 4)
        return ""
    n := NumGet(lenBuf, 0, "UInt")
    if n = 0 || n > 16 * 1024 * 1024
        throw Error("Bad message length.")
    buf := Buffer(n)
    if !ReadExact(buf, n)
        return ""
    return StrGet(buf, n, "UTF-8")
}

ReadExact(buf, n) {
    got := 0
    while got < n {
        r := 0
        if !DllCall("ReadFile", "Ptr", hIn, "Ptr", buf.Ptr + got, "UInt", n - got, "UInt*", &r, "Ptr", 0) || r = 0
            return false
        got += r
    }
    return true
}

WriteMessage(json) {
    Critical
    size := StrPut(json, "UTF-8") - 1
    out := Buffer(4 + size + 1)
    NumPut("UInt", size, out, 0)
    StrPut(json, out.Ptr + 4, size + 1, "UTF-8")
    sent := 0, total := 4 + size
    while sent < total {
        w := 0
        if !DllCall("WriteFile", "Ptr", hOut, "Ptr", out.Ptr + sent, "UInt", total - sent, "UInt*", &w, "Ptr", 0) || w = 0
            return
        sent += w
    }
}

JsonEscape(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`n", "\n")
    s := StrReplace(s, "`r", "\r")
    s := StrReplace(s, "`t", "\t")
    Loop 31 {
        if A_Index != 9 && A_Index != 10 && A_Index != 13
            s := StrReplace(s, Chr(A_Index), Format("\u{:04x}", A_Index))
    }
    return s
}

JsonUnescape(s) {
    out := "", pos := 1
    while b := InStr(s, "\", , pos) {
        out .= SubStr(s, pos, b - pos)
        e := SubStr(s, b + 1, 1)
        switch e {
            case "n": out .= "`n", pos := b + 2
            case "r": out .= "`r", pos := b + 2
            case "t": out .= "`t", pos := b + 2
            case "b": out .= "`b", pos := b + 2
            case "f": out .= "`f", pos := b + 2
            case "u": out .= Chr("0x" SubStr(s, b + 2, 4)), pos := b + 6
            default:  out .= e, pos := b + 2
        }
    }
    return out SubStr(s, pos)
}
