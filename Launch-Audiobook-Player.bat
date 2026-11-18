@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=4173"
set "APP_URL=http://127.0.0.1:%PORT%"

where node >nul 2>&1
if errorlevel 1 (
  echo [Audiobook Player] Node.js was not found in PATH.
  echo Please install Node.js 18+ from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

call :check_port
if errorlevel 1 (
  start "Audiobook Player Server" /min node -e "const http=require('http'),fs=require('fs'),path=require('path');const root=process.cwd();const base=root.endsWith(path.sep)?root:root+path.sep;const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg','.m4b':'audio/mp4','.m4a':'audio/mp4','.ogg':'audio/ogg','.wav':'audio/wav','.flac':'audio/flac'};http.createServer((req,res)=>{let p='/';try{p=decodeURIComponent(new URL(req.url,'http://127.0.0.1:4173').pathname)}catch{}if(p==='/')p='/index.html';const f=path.resolve(root,'.'+p);if(!f.startsWith(base)){res.writeHead(403);return res.end()}fs.stat(f,(e,s)=>{if(e||!s.isFile()){res.writeHead(404);return res.end('Not found')}const ct=mime[path.extname(f).toLowerCase()]||'application/octet-stream';res.writeHead(200,{'Content-Type':ct,'Content-Length':s.size,'Cache-Control':'no-cache'});fs.createReadStream(f).pipe(res)})}).listen(4173,'127.0.0.1',()=>console.log('Audiobook Player running at http://127.0.0.1:4173'));"
  for /L %%I in (1,1,15) do (
    call :check_port
    if not errorlevel 1 goto :launch_browser
    node -e "setTimeout(()=>process.exit(0),200)"
  )
)

:launch_browser
set "BROWSER="

for %%P in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist "%%~P" set "BROWSER=%%~P"
)

if not defined BROWSER (
  for /f "delims=" %%P in ('where msedge 2^>nul') do if not defined BROWSER set "BROWSER=%%P"
)
if not defined BROWSER (
  for /f "delims=" %%P in ('where chrome 2^>nul') do if not defined BROWSER set "BROWSER=%%P"
)

if defined BROWSER (
  start "" "%BROWSER%" "--app=%APP_URL%"
) else (
  start "" "%APP_URL%"
)
exit /b 0

:check_port
node -e "const n=require('net');const s=n.createConnection(4173,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),350);" >nul 2>&1
exit /b %errorlevel%
