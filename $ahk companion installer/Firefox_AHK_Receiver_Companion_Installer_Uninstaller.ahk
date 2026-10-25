#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon

; Compiled, double-click = installer/uninstaller (per-user, no admin).
; Started by Firefox (native messaging) = helper: one per Firefox process, lives and dies with it.
; Hotkeys only fire while the owning Firefox process has the active window, so multiple profiles work.
; Type P rows open an AHK popup (own GUI, positioned at the page viewport's top left); main hotkeys pause while it is open.
; popup_select / popup_close take the same field syntax as list shortcuts (several hotkeys, @ conditions).
; A hotkey that handles a popup key stays armed until the key is released, so its key-up is swallowed too (no context menu on RButton).
; Protocol (4-byte length + UTF-8 JSON):
;   add-on -> helper: {"id":N,"cmd":"read"} | {"id":N,"cmd":"write","text":"<ini>"}
;   helper -> add-on: {"id":N,"ok":true,...} | {"cmd":"open","url":"..."} | {"cmd":"options"} | {"cmd":"focusnew"}

ID := "ahkreceiver@ccc000i.addon"
NAME := "Firefox AHK Receiver"
REGKEY := "HKCU\Software\Mozilla\NativeMessagingHosts\ahk_receiver"
DEFAULT_INI := "background = #000`r`nactive_font = #E0E0E0`r`ncleared_font = #555`r`noptions_key = !o`r`nlist = `"`r`n(`r`n)`""
ini := A_ScriptDir "\" NAME ".ini"
ownerPid := 0, ownerExe := "", ownerArgs := "", hIn := 0, hOut := 0
last := Chr(1), active := []   ; Chr(1): never equals real file text
codeFiles := Map()   ; code row text -> temp script path
ctx := Map(), flags := Map()   ; HotIf callbacks per condition string, mapped flag views per name
cfg := {bg: "000000", fg: "E0E0E0", sel: "LButton", close: "Escape", pos: "center"}
pops := Map(), pops.CaseSense := "Off"   ; popup name -> [{u, label, items: [{k, c}]}]
pctx := Map(), sctx := Map(), popCtl := [], docAcc := "", docRetry := 0
held := Map(), held.CaseSense := "Off"   ; hotkey name -> true while its key is still down after the popup closed
popName := "", popGui := "", popOwner := 0, popRows := [], popNat := 0, popShown := 0
rowH := 0, popVp := "", popTick := 0, popHov := 0, popMx := 0, popMy := 0, popY := 0
CoordMode("Mouse", "Screen")

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
    OnExit(CleanCode)
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

; List line: "<field><TAB><url>" (legacy "hotkey:url" / "hotkey|conds|url" also read); url "[Name]" opens popup Name.
; popups block: "[Name]" header lines, each followed by "<field><TAB><url>" lines.
; Field: "hotkey [@ cond [& cond] [| cond & cond]] [_ hotkey ...]"; spaces around @ & | _ are optional; \@ \& \| \_ are literal.
Apply(txt) {
    ClosePopup()
    optKey := "", items := [], mode := "", cur := ""
    pops.Clear()
    cfg.bg := "000000", cfg.fg := "E0E0E0", cfg.sel := "LButton", cfg.close := "Escape", cfg.pos := "center"
    for line in StrSplit(txt, "`n", "`r") {
        t := Trim(line)
        if mode != "" {
            if SubStr(t, 1, 1) = ")"
                mode := ""
            else if mode = "popups" {
                if RegExMatch(t, "^\[([^\[\]`t]+)\]$", &m) {
                    cur := Trim(m[1])
                    if !pops.Has(cur)
                        pops[cur] := []
                } else if cur != "" && (p := InStr(t, "`t")) && (u := Trim(SubStr(t, p + 1))) != ""
                    AddPopField(pops[cur], Trim(SubStr(t, 1, p - 1)), u)
            } else if (p := InStr(t, "`t")) {
                if (u := Trim(SubStr(t, p + 1))) != ""
                    AddField(items, Trim(SubStr(t, 1, p - 1)), u)
            } else if RegExMatch(t, "^([^:|]+)\|([^|]*)\|(.+)$", &m)
                AddField(items, Trim(m[1]) (Trim(m[2]) != "" ? " @ " RegExReplace(Trim(m[2]), "\s*,\s*", " & ") : ""), m[3])
            else if RegExMatch(t, "^(.+?):(.+)$", &m)
                AddField(items, m[1], m[2])
        } else if RegExMatch(t, "i)^(options_key|background|active_font|popup_select|popup_close|popup_position)\s*=\s*(.+)$", &o) {
            v := Trim(o[2])
            switch StrLower(o[1]) {
                case "options_key": optKey := v
                case "background": cfg.bg := Hex6(v, cfg.bg)
                case "active_font": cfg.fg := Hex6(v, cfg.fg)
                case "popup_select": cfg.sel := v
                case "popup_close": cfg.close := v
                case "popup_position": cfg.pos := RegExMatch(v, "i)^(center|cursor|viewport)$") ? StrLower(v) : "center"
            }
        } else if RegExMatch(t, "i)^(list|popups)\s*=", &o)
            mode := StrLower(o[1]), cur := ""
    }
    for a in active {
        HotIf(a.fn)
        try Hotkey(a.k, "Off")
    }
    active.Length := 0
    held.Clear()
    SetPopKeys(false)
    popCtl.Length := 0
    binds := []
    for it in items {
        if RegExMatch(it.u, "^\[([^\[\]]+)\]$", &pm) {
            h := oPopup.Bind(Trim(pm[1]))   ; empty/missing popups bind too and do nothing
        } else
            h := (IsCode(it.u) ? oCode : oURL).Bind(it.u)
        binds.Push({k: it.k, c: it.c, n: "", h: h, sys: ""})
    }
    for n, list in pops
        for r in list
            for it in r.items
                binds.Push({k: it.k, c: it.c, n: n, h: HoldKey.Bind(oPick.Bind(r.u)), sys: ""})
    ; popup select/close: same field syntax as list shortcuts; created disabled, switched on only while a popup is open
    for kind in ["sel", "close"] {
        its := []
        AddField(its, cfg.%kind%, "")
        for it in its
            binds.Push({k: it.k, c: it.c, n: "", h: HoldKey.Bind(kind = "sel" ? oPopClick : oPopClose), sys: kind})
    }
    ; conditional binds first: for the same key, the first matching context wins
    for pass in [1, 2]
        for b in binds {
            if (b.c != "") != (pass = 1)
                continue
            fn := b.sys != "" ? GetSysCtx(b.sys, b.c) : b.n = "" ? GetCtx(b.c) : GetPopCtx(b.n, b.c)
            HotIf(fn)
            try {
                Hotkey(b.k, b.h, b.sys != "" ? "Off" : "On")
                if b.sys != ""
                    popCtl.Push({k: b.k, fn: fn})
                else
                    active.Push({k: b.k, fn: fn})
            }
        }
    if optKey != ""
        try {
            HotIf(MainCheck)
            Hotkey(optKey, oOptions, "On")
            active.Push({k: optKey, fn: MainCheck})
        }
    HotIf()
}

Hex6(s, def) {
    s := LTrim(Trim(s), "#")
    if RegExMatch(s, "^[0-9A-Fa-f]{3}$")
        s := SubStr(s, 1, 1) SubStr(s, 1, 1) SubStr(s, 2, 1) SubStr(s, 2, 1) SubStr(s, 3, 1) SubStr(s, 3, 1)
    return RegExMatch(s, "^[0-9A-Fa-f]{6}$") ? s : def
}

AddPopField(list, field, u) {
    its := []
    AddField(its, field, u)   ; field "_" yields no hotkeys: click-only entry
    lab := ""
    for it in its
        lab .= (lab = "" ? "" : " / ") it.k
    list.Push({u: u, label: lab, items: its})
}

AddField(items, field, u) {
    for e in SplitRe(RegExReplace(field, "\s+", " "), "\s*(?<!\\)_+\s*") {
        if e = ""
            continue
        if RegExMatch(e, "^(.+?)\s*(?<!\\)@\s*(.+)$", &m)
            items.Push({k: Unesc(Trim(m[1])), c: Trim(m[2]), u: u})
        else
            items.Push({k: Unesc(e), c: "", u: u})
    }
}

Unesc(s) => RegExReplace(s, "\\([@&|_])", "$1")

SplitRe(s, re) {
    r := [], pos := 1
    while RegExMatch(s, re, &m, pos) {
        r.Push(Trim(SubStr(s, pos, m.Pos - pos)))
        pos := m.Pos + m.Len
    }
    r.Push(Trim(SubStr(s, pos)))
    return r
}

GetCtx(c) {
    if c = ""
        return MainCheck
    if !ctx.Has(c) {
        alts := ParseConds(c)
        ctx[c] := (*) => MainCheck() && CondsOk(alts)
    }
    return ctx[c]
}

MainCheck(*) => popName = "" && FocusCheck()

GetPopCtx(n, c) {
    key := n "`n" c
    if !pctx.Has(key) {
        alts := ParseConds(c)
        ; held.Has(hk): the key is still down after the popup closed, so its key-up is swallowed like its key-down
        pctx[key] := (hk) => popName = n ? FocusCheck() && (c = "" || CondsOk(alts)) : held.Has(hk)
    }
    return pctx[key]
}

; Context of a popup select/close key: a popup is open (and the conditions hold), or the key is still held
GetSysCtx(kind, c) {
    key := kind "`n" c
    if !sctx.Has(key) {
        alts := ParseConds(c)
        sctx[key] := (hk) => popName != "" ? FocusCheck() && (c = "" || CondsOk(alts)) : held.Has(hk)
    }
    return sctx[key]
}

; "a & b | c & d" -> [[a, b], [c, d]] (OR of ANDs)
ParseConds(s) {
    alts := []
    for alt in SplitRe(s, "\s*(?<!\\)\|\s*") {
        terms := []
        for p in SplitRe(alt, "\s*(?<!\\)&\s*") {
            if RegExMatch(p, "^(\w+):(\S+)$", &m)
                terms.Push({t: StrLower(m[1]), v: Unesc(m[2])})
            else
                terms.Push({t: "", v: ""})   ; malformed: never true
        }
        alts.Push(terms)
    }
    return alts
}

CondsOk(alts) {
    for terms in alts {
        hit := true
        for c in terms {
            ok := false
            try ok := c.t = "gks" ? GetKeyState(c.v) : c.t = "gf" ? FlagSet(c.v) : false
            if !ok {
                hit := false
                break
            }
        }
        if hit
            return true
    }
    return false
}

; Reads a 4-byte int from a named shared memory mapping ("Global\" is prepended unless the name has a "\")
FlagSet(name) {
    if !flags.Has(name) {
        h := DllCall("OpenFileMappingW", "UInt", 4, "Int", 0, "Str", InStr(name, "\") ? name : "Global\" name, "Ptr")
        if !h
            return false
        p := DllCall("MapViewOfFile", "Ptr", h, "UInt", 4, "UInt", 0, "UInt", 0, "UPtr", 4, "Ptr")
        if !p {
            DllCall("CloseHandle", "Ptr", h)
            return false
        }
        flags[name] := p
    }
    return NumGet(flags[name], 0, "Int") != 0
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

IsCode(u) => SubStr(u, 1, 1) = "{" && SubStr(u, -1) = "}"

; Code row "{code}": | = line break, \| = literal pipe. Runs as a separate AHK v2 script (written once per distinct code).
oCode(u, *) {
    if !codeFiles.Has(u) {
        code := StrReplace(SubStr(u, 2, -1), "\|", Chr(1))
        code := StrReplace(StrReplace(code, "|", "`n"), Chr(1), "|")
        path := A_Temp "\" NAME "-" ownerPid "-" (codeFiles.Count + 1) ".ahk"
        try WriteFile(path, "#Requires AutoHotkey v2.0`n#SingleInstance Off`n#NoTrayIcon`n" code "`n", "UTF-8")
        catch
            return
        codeFiles[u] := path
    }
    try Run((A_IsCompiled ? '"' A_ScriptFullPath '" /script' : '"' A_AhkPath '"') ' "' codeFiles[u] '"')
}

CleanCode(*) {
    try FileDelete(A_Temp "\" NAME "-" ownerPid "-*.ahk")
    return 0
}

; ---------------- Popup ----------------

oPopup(name, *) {
    global popName, popGui, popOwner, popRows, popNat, rowH, popVp, popTick, popHov, docRetry, popMx, popMy
    if popName != "" || !pops.Has(name) || !pops[name].Length
        return
    popOwner := FocusCheck()
    if !popOwner
        return
    MouseGetPos(&popMx, &popMy)
    data := pops[name]
    kw := 0
    for r in data
        kw := Max(kw, StrLen(r.label))
    g := Gui("-Caption +ToolWindow +AlwaysOnTop -DPIScale +E0x08000000")   ; E0x08000000: never takes focus from Firefox
    g.MarginX := 0, g.MarginY := 0
    g.BackColor := cfg.bg
    g.SetFont("s10 c" cfg.fg, "Consolas")
    popRows := [], popNat := 1
    for i, r in data {
        pad := ""
        Loop kw - StrLen(r.label)
            pad .= " "
        c := g.Add("Text", "x0 y0 +0x80 +0xC +0x200", "  " r.label pad "  " r.u "  ")   ; no prefix, no wrap, v-centered
        c.GetPos(, , &w, &h)
        if i = 1
            rowH := h + 6
        popNat := Max(popNat, w)
        popRows.Push(c)
    }
    popGui := g
    popName := name
    popHov := 0, popTick := 0, docRetry := 0
    popVp := ViewRect()
    PopLayout(popVp)
    SetPopKeys(true)
    SetTimer(PopTimer, 50)
}

; Sizes the popup to its content, capped to the viewport; rows that do not fit are hidden (their keys still work)
PopLayout(vp) {
    global popShown, popY
    popShown := Min(popRows.Length, Max(1, vp.h // rowH))
    w := Max(1, Min(popNat, vp.w))
    for i, c in popRows {
        if i > popShown {
            c.Visible := false
            continue
        }
        c.Visible := true
        c.Move(0, (i - 1) * rowH, w, rowH)
    }
    hh := popShown * rowH
    x := vp.x, y := vp.y
    if cfg.pos != "viewport" {   ; at the cursor position from opening, kept inside the viewport
        x := popMx - (cfg.pos = "center" ? w // 2 : rowH // 2)   ; cursor mode: cursor lands mid-height in the first row, same distance from the left
        y := popMy - (cfg.pos = "center" ? hh // 2 : rowH // 2)
        x := Max(vp.x, Min(x, vp.x + vp.w - w))
        y := Max(vp.y, Min(y, vp.y + vp.h - hh))
    }
    popY := y
    popGui.Show("NA x" x " y" y " w" w " h" hh)
}

PopTimer() {
    global popVp, popTick, popHov
    if popName = "" {
        SetTimer(PopTimer, 0)
        return
    }
    if FocusCheck() != popOwner {
        ClosePopup()
        return
    }
    i := RowAt()
    if i != popHov {
        PopHover(popHov, false)
        PopHover(i, true)
        popHov := i
    }
    if ++popTick >= 4 {
        popTick := 0
        vp := ViewRect()
        if vp.x != popVp.x || vp.y != popVp.y || vp.w != popVp.w || vp.h != popVp.h {
            popVp := vp
            PopLayout(vp)
        }
    }
}

PopHover(i, on) {
    if i < 1 || i > popRows.Length
        return
    c := popRows[i]
    c.Opt("Background" (on ? cfg.fg : cfg.bg))
    c.SetFont("c" (on ? cfg.bg : cfg.fg))
    c.Redraw()
}

RowAt() {
    MouseGetPos(&mx, &my, &win)
    if popName = "" || win != popGui.Hwnd
        return 0
    i := (my - popY) // rowH + 1
    return i >= 1 && i <= popShown ? i : 0
}

oPopClick(*) {
    if popName = ""
        return
    if (i := RowAt())
        oPick(pops[popName][i].u)
    else
        ClosePopup()
}

oPopClose(*) => ClosePopup()

oPick(u, *) {
    ClosePopup()
    f := IsCode(u) ? oCode : oURL
    f(u)
}

; Wraps a popup hotkey action: after it ran, the hotkey stays armed until its key is released,
; so AHK swallows the key-up as well (otherwise e.g. RButton would still open the context menu on release).
HoldKey(fn, *) {
    hk := A_ThisHotkey
    if popName = ""   ; auto-repeat of a key that already closed the popup
        return
    held[hk] := true
    try fn()
    if (base := HoldBase(hk)) != ""
        try KeyWait(base, "T10")
    Sleep(40)
    try held.Delete(hk)
    if popName = "" && !held.Count
        SetPopKeys(false)
}

; "^+RButton" -> "RButton", "a & b up" -> "b"
HoldBase(hk) {
    hk := RegExReplace(hk, "i)\s+up$")
    if p := InStr(hk, " & ", , -1)
        hk := SubStr(hk, p + 3)
    return RegExReplace(hk, "^[~*$<>^!+#]+")
}

SetPopKeys(on) {
    for c in popCtl {
        HotIf(c.fn)
        try Hotkey(c.k, on ? "On" : "Off")
    }
    HotIf()
}

ClosePopup() {
    global popName, popGui, popRows, docAcc
    if popName = ""
        return
    SetTimer(PopTimer, 0)
    popName := ""
    if !held.Count   ; a key that is still down keeps its hotkeys until released (see HoldKey)
        SetPopKeys(false)
    try popGui.Destroy()
    popGui := "", popRows := [], docAcc := ""
}

; Page viewport in screen pixels (accessibility document of the active tab); falls back to the window's client area
ViewRect() {
    global docAcc, docRetry
    r := ""
    if docAcc {
        try r := AccRect(docAcc)
        if !r
            docAcc := ""
    }
    if !r && A_TickCount >= docRetry {
        docAcc := FindDoc(popOwner)
        if docAcc
            try r := AccRect(docAcc)
        if !r
            docRetry := A_TickCount + 2000
    }
    if r && r.w > 0 && r.h > 0
        return r
    return ClientRect(popOwner)
}

ClientRect(hwnd) {
    rc := Buffer(16), pt := Buffer(8, 0)
    DllCall("GetClientRect", "Ptr", hwnd, "Ptr", rc)
    DllCall("ClientToScreen", "Ptr", hwnd, "Ptr", pt)
    return {x: NumGet(pt, 0, "Int"), y: NumGet(pt, 4, "Int"), w: NumGet(rc, 8, "Int"), h: NumGet(rc, 12, "Int")}
}

; ---- MSAA ----

AccFromWindow(hwnd) {
    iid := Buffer(16), ppv := 0
    DllCall("ole32\CLSIDFromString", "Str", "{618736E0-3C3D-11CF-810C-00AA00389B71}", "Ptr", iid)
    if DllCall("oleacc\AccessibleObjectFromWindow", "Ptr", hwnd, "UInt", 0xFFFFFFFC, "Ptr", iid, "Ptr*", &ppv) || !ppv
        return ""
    return ComObjFromPtr(ppv)
}

AccKids(acc) {
    kids := []
    try {
        n := acc.accChildCount
        if n < 1
            return kids
        sz := 8 + 2 * A_PtrSize
        buf := Buffer(n * sz, 0)
        got := 0
        DllCall("oleacc\AccessibleChildren", "Ptr", ComObjValue(acc), "Int", 0, "Int", n, "Ptr", buf, "Int*", &got)
        Loop got {
            o := (A_Index - 1) * sz
            if NumGet(buf, o, "UShort") = 9   ; VT_DISPATCH
                kids.Push(ComObjFromPtr(NumGet(buf, o + 8, "Ptr")))
        }
    }
    return kids
}

; Screen rect of a visible accessible, "" if it is invisible/offscreen
AccRect(acc) {
    if acc.accState(0) & 0x18000   ; INVISIBLE | OFFSCREEN
        return ""
    x := Buffer(4), y := Buffer(4), w := Buffer(4), h := Buffer(4)
    acc.accLocation(ComValue(0x4003, x.Ptr), ComValue(0x4003, y.Ptr), ComValue(0x4003, w.Ptr), ComValue(0x4003, h.Ptr), 0)
    return {x: NumGet(x, "Int"), y: NumGet(y, "Int"), w: NumGet(w, "Int"), h: NumGet(h, "Int")}
}

; Largest visible ROLE_SYSTEM_DOCUMENT in the window's accessibility tree (the page, not a sidebar)
FindDoc(hwnd) {
    root := AccFromWindow(hwnd)
    if !root
        return ""
    st := {acc: "", area: 0, n: 0}
    AccWalk(root, 0, st)
    return st.acc
}

AccWalk(acc, depth, st) {
    static skip := Map(1, 1, 2, 1, 3, 1, 11, 1, 22, 1, 23, 1, 41, 1, 43, 1, 60, 1)   ; title/menu bars, scrollbar, popups, toolbars, status, text, buttons, tab list
    for ch in AccKids(acc) {
        if ++st.n > 4000
            return
        try {
            role := ch.accRole(0)
            if role = 15 {
                if (r := AccRect(ch)) && r.w * r.h > st.area
                    st.acc := ch, st.area := r.w * r.h
            } else if depth < 14 && !skip.Has(role)
                AccWalk(ch, depth + 1, st)
        }
    }
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
