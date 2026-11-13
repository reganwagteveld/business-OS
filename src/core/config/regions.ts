// The single place where region identifiers appear in source code (ADR 0002).
// Everything else reads regions from validated environment config.

/** Vercel function region codes and the AWS region each one runs in. */
export const VERCEL_TO_AWS_REGION: Readonly<Record<string, string>> = {
  iad1: 'us-east-1',
  cle1: 'us-east-2',
  pdx1: 'us-west-2',
  sfo1: 'us-west-1',
  yul1: 'ca-central-1',
  gru1: 'sa-east-1',
  dub1: 'eu-west-1',
  lhr1: 'eu-west-2',
  cdg1: 'eu-west-3',
  fra1: 'eu-central-1',
  arn1: 'eu-north-1',
  syd1: 'ap-southeast-2',
  sin1: 'ap-southeast-1',
  hnd1: 'ap-northeast-1',
  kix1: 'ap-northeast-3',
  icn1: 'ap-northeast-2',
  bom1: 'ap-south-1',
  hkg1: 'ap-east-1',
  cpt1: 'af-south-1',
};
