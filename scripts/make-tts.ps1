# 文のリスト（JSON の say）を Windows の日本語音声で読み上げ、16kHz モノラルの WAV にする。
# 文の間に無音を入れて 1 本の「作業セッション」にする（VAD で区切れるかも確かめるため）。
param(
  [Parameter(Mandatory)] [string] $SentencesJson,
  [Parameter(Mandatory)] [string] $OutDir,
  [string[]] $Voices = @('Microsoft Haruka Desktop', 'Microsoft Ichiro', 'Microsoft Sayaka'),
  [int] $PauseMs = 1200
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$sentences = Get-Content $SentencesJson -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($voice in $Voices) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voice)
  $prompt = New-Object System.Speech.Synthesis.PromptBuilder([System.Globalization.CultureInfo]'ja-JP')
  $prompt.AppendBreak([TimeSpan]::FromMilliseconds(500))
  foreach ($s in $sentences) {
    $prompt.AppendText($s.say)
    $prompt.AppendBreak([TimeSpan]::FromMilliseconds($PauseMs))
  }
  $name = ($voice -replace '^Microsoft ', '' -replace ' ', '-').ToLower()
  $file = Join-Path $OutDir "$name.wav"
  $synth.SetOutputToWaveFile($file, $format)
  $synth.Speak($prompt)
  $synth.SetOutputToNull()
  $synth.Dispose()
  "{0}`t{1:N1} KB" -f $file, ((Get-Item $file).Length / 1KB)
}
