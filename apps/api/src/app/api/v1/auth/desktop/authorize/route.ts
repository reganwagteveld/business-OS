import { authorizeDesktop, confirmDesktop } from '@/modules/identity';

export const dynamic = 'force-dynamic';
export const GET = authorizeDesktop;
export const POST = confirmDesktop;
