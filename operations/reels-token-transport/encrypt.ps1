$ErrorActionPreference='Stop'
$rsa=$null
$aes=$null
$key=$null
$plain=$null
try {
  $value=([Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable -DateKind String)
  $request=$value.request
  $rsa=[System.Security.Cryptography.RSA]::Create()
  $rsa.ImportFromPem([string]$request.public_key_pem)
  if ($rsa.KeySize -ne 4096) { throw 'recipient' }
  $key=[System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $iv=[System.Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
  $plain=[Text.Encoding]::ASCII.GetBytes(($value.payload | ConvertTo-Json -Compress -Depth 10))
  $aad=[Convert]::FromBase64String([string]$value.aad_b64)
  $cipher=New-Object byte[] $plain.Length
  $tag=New-Object byte[] 16
  $aes=[System.Security.Cryptography.AesGcm]::new($key,16)
  $aes.Encrypt($iv,$plain,$cipher,$tag,$aad)
  $combined=New-Object byte[] ($cipher.Length+$tag.Length)
  [Buffer]::BlockCopy($cipher,0,$combined,0,$cipher.Length)
  [Buffer]::BlockCopy($tag,0,$combined,$cipher.Length,$tag.Length)
  $wrapped=$rsa.Encrypt($key,[System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  $result=[ordered]@{
    schema='api-token-envelope.v1'
    request_sha256=[string]$value.request_sha256
    wrapped_key=[Convert]::ToBase64String($wrapped)
    iv=[Convert]::ToBase64String($iv)
    ciphertext=[Convert]::ToBase64String($combined)
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.Write('crypto_failed')
  exit 1
} finally {
  if ($key) { [Array]::Clear($key,0,$key.Length) }
  if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
  if ($aes) { $aes.Dispose() }
  if ($rsa) { $rsa.Dispose() }
}
