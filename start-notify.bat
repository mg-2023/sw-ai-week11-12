@echo off
rem Keep this file ASCII only. cmd loses its place in the file on multibyte lines.
rem PowerShell gets its own window, so Ctrl+C closes it without the batch job prompt.
start "mini-react notify" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify-helper.ps1"
