import { randomInt } from "node:crypto";

import type { RandomInt } from "./rules";

export const cryptoRandomInt: RandomInt = (maxExclusive: number) => randomInt(maxExclusive);
