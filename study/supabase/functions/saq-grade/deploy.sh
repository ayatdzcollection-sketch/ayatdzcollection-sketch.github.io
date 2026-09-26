#!/bin/sh
# Deploys the AI Edge Functions (saq-grade, study-ask and study-gen) and sets the Anthropic key they share.
# Nothing is written to disk by this script and neither secret belongs in the repo: both are read
# from the environment for this one command.
#
#   export SUPABASE_ACCESS_TOKEN=sbp_...        Supabase account settings, Access Tokens
#   export ANTHROPIC_API_KEY=sk-ant-...         console.anthropic.com, API keys
#   sh study/supabase/functions/saq-grade/deploy.sh
#
# Then turn each feature on in the hub owner panel: AI grading, master switch, and the ask row.
set -e
REF=gyfqhkhgosjpyvatffbi
FUNCTIONS="saq-grade study-ask study-gen"
if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then echo "SUPABASE_ACCESS_TOKEN is not set"; exit 1; fi
if [ -z "$ANTHROPIC_API_KEY" ]; then echo "ANTHROPIC_API_KEY is not set"; exit 1; fi
# The CLI wants the directory that holds supabase/, which here is study/.
DIR=$(cd "$(dirname "$0")/../../.." && pwd)
echo "setting the function secret"
npx --yes supabase@latest secrets set "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" --project-ref "$REF" >/dev/null
for FN in $FUNCTIONS; do
  echo "deploying $FN"
  npx --yes supabase@latest functions deploy "$FN" --project-ref "$REF" --workdir "$DIR"
done
echo "done. The functions are at:"
for FN in $FUNCTIONS; do
  echo "  https://$REF.supabase.co/functions/v1/$FN"
done
