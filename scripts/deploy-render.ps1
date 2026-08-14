# ============================================================================
# deploy-render.ps1 — provision the WhatsApp AI Business OS on Render via the
# Render Public API (https://api.render.com/v1).
#
# Creates / wires: Postgres, Redis, the API web service, and the worker
# background service. Then prints the secrets checklist you must fill in the
# Render dashboard (never pass them here — they are set as empty placeholders).
#
# Prerequisites:
#   1. A Render API key (dashboard.render.com -> Account Settings -> API Keys)
#   2. The workspace/owner ID (your Workspace -> Settings, e.g. "tea-...")
#   3. A GitHub repo that Render can access (this repo is already pushed).
#
# Usage:
#   $env:RENDER_API_KEY  = "rnd_..."
#   $env:RENDER_OWNER_ID = "tea-..."
#   $env:REPO_URL        = "https://github.com/iamnayaya/whatsapp-ai-business-os"
#   $env:BRANCH          = "main"
#   # optional: pre-fill secrets you already have (each becomes a real value):
#   $env:WHATSAPP_VERIFY_TOKEN = "..." ; $env:GEMINI_API_KEY = "..."
#   ./scripts/deploy-render.ps1 -Plan starter            # default: starter
#   ./scripts/deploy-render.ps1 -Plan free -SkipWorker   # smoke-test only
# ============================================================================

param(
  # starter (paid, required for the worker + persistent data) | free
  [ValidateSet('starter','free')]
  [string]$Plan = 'starter',
  # Free services spin down when idle and expire; the worker needs a paid plan.
  [switch]$SkipWorker,
  [string]$Region = 'frankfurt',
  [string]$PostgresVersion = '16'
)

$ErrorActionPreference = 'Stop'
$api = 'https://api.render.com/v1'

$key   = $env:RENDER_API_KEY
$owner = $env:RENDER_OWNER_ID
$repo  = $env:REPO_URL
$branch = if ($env:BRANCH) { $env:BRANCH } else { 'main' }

if (-not $key)   { throw 'RENDER_API_KEY is required' }
if (-not $owner) { throw 'RENDER_OWNER_ID is required' }
if (-not $repo)  { throw 'REPO_URL is required' }

function Invoke-Render([string]$Method, [string]$Path, $Body = $null) {
  $headers = @{ Authorization = "Bearer $key" }
  $uri = "$api$Path"
  if ($null -eq $Body) {
    $resp = curl.exe -s -w "`n__HTTP__%{http_code}" -X $Method -H "Authorization: Bearer $key" $uri
  } else {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $tmp = Join-Path $env:TEMP "render-body.json"
    Set-Content -LiteralPath $tmp -Value $json -NoNewline -Encoding ascii
    $resp = curl.exe -s -w "`n__HTTP__%{http_code}" -X $Method -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data-binary "@$tmp" $uri
  }
  $lines = $resp -split "`n"
  $code = ($lines | Where-Object { $_ -like '__HTTP__*' }) -replace '__HTTP__',''
  $bodyText = ($lines | Where-Object { $_ -notlike '__HTTP__*' }) -join ''
  if ([int]$code -ge 400) {
    $msg = $null
    try { $msg = ($bodyText | ConvertFrom-Json).message } catch { $msg = $bodyText }
    throw "Render $Method $Path -> $code : $msg"
  }
  if ($code -eq 204) { return $null }
  if (-not $bodyText) { return $null }
  return $bodyText | ConvertFrom-Json
}

function Wait-Available([string]$Kind, [string]$Id) {
  Write-Host "Waiting for $Kind ($Id) to become available..."
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 5
    $r = Invoke-Render GET "/$Kind/$Id"
    if ($r.status -eq 'available') { Write-Host "  $Kind is available."; return $r }
  }
  throw "$Kind $Id did not become available within 150s"
}

function Get-Secret([string]$name, [string]$fallback = '') {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { return $v }
  return $fallback
}

# --- 1. Postgres ------------------------------------------------------------
$pgId = $env:PG_ID
if (-not $pgId) {
  $pgBody = @{
    name = 'wabiz-db'
    databaseName = 'whatsapp_biz_os'
    plan = $Plan
    version = $PostgresVersion
    region = $Region
    ownerId = $owner
  }
  Write-Host 'Creating Postgres (wabiz-db)...'
  $pg = Invoke-Render POST '/postgres' $pgBody
  $pgId = $pg.id
  Write-Host "  Postgres id: $pgId"
}
$pgInfo = Invoke-Render GET "/postgres/$pgId/connection-info"
$DATABASE_URL = $pgInfo.internalConnectionString
if (-not $DATABASE_URL) { $DATABASE_URL = $pgInfo.externalConnectionString }

# --- 2. Redis ---------------------------------------------------------------
$redisId = $env:REDIS_ID
if (-not $redisId) {
  $redisBody = @{
    name = 'wabiz-redis'
    plan = $Plan
    region = $Region
    ownerId = $owner
    maxmemoryPolicy = 'noeviction'
  }
  if ($Plan -ne 'free') { $redisBody.persistenceMode = 'journal_snapshot' }
  Write-Host 'Creating Redis (wabiz-redis)...'
  $redis = Invoke-Render POST '/redis' $redisBody
  $redisId = $redis.id
  Write-Host "  Redis id: $redisId"
}
$redisInfo = Invoke-Render GET "/redis/$redisId/connection-info"
$REDIS_URL = $redisInfo.internalConnectionString
if (-not $REDIS_URL) { $REDIS_URL = $redisInfo.externalConnectionString }

# --- 3. Common env vars -----------------------------------------------------
$whatsappSecrets = @(
  @{ key = 'WHATSAPP_VERIFY_TOKEN'; value = (Get-Secret 'WHATSAPP_VERIFY_TOKEN') },
  @{ key = 'WHATSAPP_APP_SECRET';   value = (Get-Secret 'WHATSAPP_APP_SECRET') },
  @{ key = 'WHATSAPP_ACCESS_TOKEN'; value = (Get-Secret 'WHATSAPP_ACCESS_TOKEN') },
  @{ key = 'WHATSAPP_PHONE_NUMBER_ID'; value = (Get-Secret 'WHATSAPP_PHONE_NUMBER_ID') },
  @{ key = 'WHATSAPP_WABA_ID';      value = (Get-Secret 'WHATSAPP_WABA_ID') }
)

$apiEnv = @(
  @{ key = 'SERVICE';       value = 'api' },
  @{ key = 'NODE_ENV';      value = 'production' },
  @{ key = 'PORT';          value = '3000' },
  @{ key = 'WEBHOOK_PATH';  value = '/webhook/whatsapp' },
  @{ key = 'DATABASE_URL';  value = $DATABASE_URL },
  @{ key = 'REDIS_URL';     value = $REDIS_URL },
  @{ key = 'WHATSAPP_API_VERSION'; value = (Get-Secret 'WHATSAPP_API_VERSION' 'v21.0') },
  @{ key = 'BUSINESS_NAME'; value = (Get-Secret 'BUSINESS_NAME' 'My Business') },
  @{ key = 'BUSINESS_CURRENCY'; value = (Get-Secret 'BUSINESS_CURRENCY' 'NGN') },
  @{ key = 'BUSINESS_TIMEZONE'; value = (Get-Secret 'BUSINESS_TIMEZONE' 'Africa/Lagos') },
  @{ key = 'ADMIN_PASSWORD'; value = (Get-Secret 'ADMIN_PASSWORD') },
  @{ key = 'ADMIN_SESSION_SECRET'; value = (Get-Secret 'ADMIN_SESSION_SECRET') },
  @{ key = 'ANALYTICS_DATABASE_URL'; value = (Get-Secret 'ANALYTICS_DATABASE_URL') }
) + $whatsappSecrets

# Empty values are OMITTED, not sent as "" — the app validates env vars at boot
# (zod) and an explicit empty string fails strict checks like ALERT_SMTP_PORT.
$apiEnv    = @($apiEnv    | Where-Object { $_.value -ne '' })

$workerEnv = @(
  @{ key = 'SERVICE';       value = 'worker' },
  @{ key = 'NODE_ENV';      value = 'production' },
  @{ key = 'DATABASE_URL';  value = $DATABASE_URL },
  @{ key = 'REDIS_URL';     value = $REDIS_URL },
  @{ key = 'WHATSAPP_API_VERSION'; value = (Get-Secret 'WHATSAPP_API_VERSION' 'v21.0') },
  @{ key = 'GEMINI_MODEL';  value = (Get-Secret 'GEMINI_MODEL' 'gemini-flash-latest') },
  @{ key = 'TRANSCRIBER_MIN_CONFIDENCE'; value = (Get-Secret 'TRANSCRIBER_MIN_CONFIDENCE' '0.5') },
  @{ key = 'FOLLOWUP_SCAN_CRON'; value = (Get-Secret 'FOLLOWUP_SCAN_CRON' '0 */15 * * * *') },
  @{ key = 'FOLLOWUP_FIRST_DELAY_MINUTES'; value = (Get-Secret 'FOLLOWUP_FIRST_DELAY_MINUTES' '120') },
  @{ key = 'FOLLOWUP_SECOND_DELAY_MINUTES'; value = (Get-Secret 'FOLLOWUP_SECOND_DELAY_MINUTES' '1440') },
  @{ key = 'FOLLOWUP_QUIET_START'; value = (Get-Secret 'FOLLOWUP_QUIET_START' '21') },
  @{ key = 'FOLLOWUP_QUIET_END'; value = (Get-Secret 'FOLLOWUP_QUIET_END' '9') },
  @{ key = 'FOLLOWUP_MAX_ATTEMPTS'; value = (Get-Secret 'FOLLOWUP_MAX_ATTEMPTS' '2') },
  @{ key = 'REFUND_ESCALATION_THRESHOLD'; value = (Get-Secret 'REFUND_ESCALATION_THRESHOLD' '50000') },
  @{ key = 'BUSINESS_NAME'; value = (Get-Secret 'BUSINESS_NAME' 'My Business') },
  @{ key = 'BUSINESS_CURRENCY'; value = (Get-Secret 'BUSINESS_CURRENCY' 'NGN') },
  @{ key = 'BUSINESS_TIMEZONE'; value = (Get-Secret 'BUSINESS_TIMEZONE' 'Africa/Lagos') },
  @{ key = 'MONITOR_ENABLED'; value = 'true' },
  @{ key = 'MONITOR_INTERVAL_MINUTES'; value = '5' },
  @{ key = 'MONITOR_WINDOW_MINUTES'; value = '15' },
  @{ key = 'MONITOR_FAILED_MESSAGES_THRESHOLD'; value = '5' },
  @{ key = 'MONITOR_FAILED_EVENTS_THRESHOLD'; value = '3' },
  @{ key = 'MONITOR_PENDING_BACKLOG_MINUTES'; value = '10' },
  @{ key = 'MONITOR_PENDING_BACKLOG_THRESHOLD'; value = '5' },
  @{ key = 'MONITOR_AI_ERROR_THRESHOLD'; value = '10' },
  @{ key = 'MONITOR_ALERT_COOLDOWN_MINUTES'; value = '30' },
  @{ key = 'GEMINI_API_KEY'; value = (Get-Secret 'GEMINI_API_KEY') },
  @{ key = 'PAYSTACK_SECRET_KEY'; value = (Get-Secret 'PAYSTACK_SECRET_KEY') },
  @{ key = 'PAYSTACK_PUBLIC_KEY'; value = (Get-Secret 'PAYSTACK_PUBLIC_KEY') },
  @{ key = 'SLACK_WEBHOOK_URL'; value = (Get-Secret 'SLACK_WEBHOOK_URL') },
  @{ key = 'ALERT_EMAIL_FROM'; value = (Get-Secret 'ALERT_EMAIL_FROM') },
  @{ key = 'ALERT_EMAIL_TO'; value = (Get-Secret 'ALERT_EMAIL_TO') },
  @{ key = 'ALERT_SMTP_HOST'; value = (Get-Secret 'ALERT_SMTP_HOST') },
  @{ key = 'ALERT_SMTP_PORT'; value = (Get-Secret 'ALERT_SMTP_PORT') },
  @{ key = 'ALERT_SMTP_SECURE'; value = (Get-Secret 'ALERT_SMTP_SECURE') },
  @{ key = 'ALERT_SMTP_USER'; value = (Get-Secret 'ALERT_SMTP_USER') },
  @{ key = 'ALERT_SMTP_PASS'; value = (Get-Secret 'ALERT_SMTP_PASS') }
) + $whatsappSecrets
$workerEnv = @($workerEnv | Where-Object { $_.value -ne '' })

# --- 4. API web service -----------------------------------------------------
$apiId = $env:API_SERVICE_ID
if (-not $apiId) {
  $apiBody = @{
    type = 'web_service'
    name = 'wabiz-api'
    ownerId = $owner
    repo = $repo
    branch = $branch
    autoDeploy = 'yes'
    envVars = $apiEnv
    serviceDetails = @{
      runtime = 'docker'
      envSpecificDetails = @{ dockerfilePath = './Dockerfile' }
      plan = $Plan
      region = $Region
      numInstances = 1
      healthCheckPath = '/health'
      buildPlan = 'starter'
      previews = @{ generation = 'off' }
    }
  }
  Write-Host 'Creating API web service (wabiz-api)...'
  $apiSvc = Invoke-Render POST '/services' $apiBody
  $apiId = $apiSvc.service.id
  Write-Host "  API service id: $apiId"
  Write-Host "  Dashboard: $($apiSvc.service.dashboardUrl)"
}

# --- 5. Worker (background worker has NO free tier — needs a paid plan) -----
if (-not $SkipWorker) {
  $workerId = $env:WORKER_SERVICE_ID
  if (-not $workerId) {
    $workerBody = @{
      type = 'background_worker'
      name = 'wabiz-worker'
      ownerId = $owner
      repo = $repo
      branch = $branch
      autoDeploy = 'yes'
      envVars = $workerEnv
      serviceDetails = @{
        runtime = 'docker'
        envSpecificDetails = @{ dockerfilePath = './Dockerfile' }
        plan = $Plan
        region = $Region
        numInstances = 1
        buildPlan = 'starter'
        previews = @{ generation = 'off' }
      }
    }
    Write-Host 'Creating worker (wabiz-worker)...'
    $workerSvc = Invoke-Render POST '/services' $workerBody
    $workerId = $workerSvc.service.id
    Write-Host "  Worker service id: $workerId"
    Write-Host "  Dashboard: $($workerSvc.service.dashboardUrl)"
  }
}

# --- 6. Migrations ----------------------------------------------------------
Write-Host 'Triggering `npm run db:deploy` (prisma migrate deploy) as a one-off job...'
if (-not $SkipWorker -and $workerId) {
  try {
    $jobBody = @{ startCommand = 'npm run db:deploy' }
    $job = Invoke-Render POST "/services/$workerId/jobs" $jobBody
    Write-Host "  Migration job: $($job.id)"
  } catch {
    Write-Host "  (migration job skipped: $_)"
  }
}

Write-Host ''
Write-Host '============================================================================'
Write-Host ' Provisioned. Now fill these SECRETS in the Render dashboard'
Write-Host ' (each service -> Environment). Empty values here were left blank.'
Write-Host '============================================================================'
Write-Host 'API  service (wabiz-api):'
Write-Host '  WHATSAPP_VERIFY_TOKEN   -> the value you paste into Meta webhook config'
Write-Host '  WHATSAPP_APP_SECRET     -> Meta app secret'
Write-Host '  WHATSAPP_ACCESS_TOKEN   -> long-lived system-user token'
Write-Host '  WHATSAPP_PHONE_NUMBER_ID-> WhatsApp product settings'
Write-Host '  ADMIN_PASSWORD          -> dashboard + kill-switch password'
Write-Host '  ANALYTICS_DATABASE_URL  -> optional read-only Postgres URL'
Write-Host 'Worker service (wabiz-worker):'
Write-Host '  GEMINI_API_KEY          -> worker refuses to boot without it'
Write-Host '  PAYSTACK_SECRET_KEY     -> required for payment links + webhook'
Write-Host '  SLACK_WEBHOOK_URL       -> alert channel (recommended)'
Write-Host '  ALERT_EMAIL_* / ALERT_SMTP_* -> optional second alert channel'
Write-Host ''
Write-Host 'Then subscribe Meta + Paystack webhooks:'
Write-Host "  https://<your-api-domain>$((Get-Secret 'WEBHOOK_PATH' '/webhook/whatsapp'))"
Write-Host '  https://<your-api-domain>/webhook/paystack'
Write-Host ''
Write-Host 'Free tier: the worker has no free tier; set -SkipWorker or add a card.'
Write-Host 'Free databases/redis expire in 30 days and the quota is 1 per workspace.'
Write-Host '============================================================================'