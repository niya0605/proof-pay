import { reauthorizeDue } from "../services/paymentService.ts";

/** After the 3-day honor period, try to reauthorize once; failure or expiry → AUTH_EXPIRED. Untested against sandbox (needs a 3-day-old authorization). */
export const reauthorizeJob = () => reauthorizeDue(Date.now());
