#!/bin/sh
# Deploys saq-grade and sets its Anthropic key. Nothing is written to disk by this script and
# neither secret belongs in the repo: both are read from the environment for this one command.
#
#   export SUPABASE_ACCESS_TOKEN=sbp_...        Supabase account settings, Access Tokens
#   export ANTHROPIC_API_KEY=sk-ant-...         console.anthropic.com, API keys
#   sh study/supabase/functions/saq-grade/deploy.sh
#
# Then turn the feature on in the hub owner panel, AI grading, master switch.
set -e
REF=gyfqhkhgosjpyvatffbi
if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then echo "SUPABASE_ACCESS_TOKEN is not set"; exit 1; fi
if [ -z "$ANTHROPIC_API_KEY" ]; then echo "ANTHROPIC_API_KEY is not set"; exit 1; fi
# The CLI wants the directory that holds supabase/, which here is study/.
DIR=$(cd "$(dirname "$0")/../../.." && pwd)
echo "setting the function secret"
npx --yes supabase@latest secrets set "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" --project-ref "$REF" >/dev/null
echo "deploying the function"
npx --yes supabase@latest functions deploy saq-grade --project-ref "$REF" --workdir "$DIR"
echo "done. The function is at https://$REF.supabase.co/functions/v1/saq-grade"
