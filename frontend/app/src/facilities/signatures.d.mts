import type { FacilityReadClient } from "./reader.mjs";
import type { SignedQuote, VerifiedBlock } from "./quotes.mjs";
export function verifyFacilitySignature(client: Pick<FacilityReadClient, "readContract">, envelope: SignedQuote,
  block: Pick<VerifiedBlock, "number">): Promise<boolean>;
