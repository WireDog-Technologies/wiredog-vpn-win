import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import azFlag from "@/assets/flags/Flag_of_Arizona.svg";
import caFlag from "@/assets/flags/Flag_of_California.svg";
import coFlag from "@/assets/flags/Flag_of_Colorado.svg";
import flFlag from "@/assets/flags/Flag_of_Florida.svg";
import gaFlag from "@/assets/flags/Flag_of_the_State_of_Georgia.svg";
import ilFlag from "@/assets/flags/Flag_of_Illinois.svg";
import maFlag from "@/assets/flags/Flag_of_Massachusetts.svg";
import miFlag from "@/assets/flags/Flag_of_Michigan.svg";
import mnFlag from "@/assets/flags/Flag_of_Minnesota.svg";
import nvFlag from "@/assets/flags/Flag_of_Nevada.svg";
import nyFlag from "@/assets/flags/Flag_of_New_York.svg";
import ncFlag from "@/assets/flags/Flag_of_North_Carolina.svg";
import ohFlag from "@/assets/flags/Flag_of_Ohio.svg";
import orFlag from "@/assets/flags/Flag_of_Oregon.svg";
import paFlag from "@/assets/flags/Flag_of_Pennsylvania.svg";
import txFlag from "@/assets/flags/Flag_of_Texas.svg";
import vaFlag from "@/assets/flags/Flag_of_Virginia.svg";
import waFlag from "@/assets/flags/Flag_of_Washington.svg";
import usFlag from "@/assets/flags/Flag_of_the_United_States.svg";

/**
 * Merge Tailwind class names intelligently
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Return a simple emoji or symbol representing a US state
 * @param stateCode - the 2-letter US state code (e.g., 'NY', 'CA')
 * @returns string emoji for the state
 */
export function getUSStateFlag(stateCode: string): string {
  const stateFlags: Record<string, string> = {
    NY: nyFlag,
    CA: caFlag,
    TX: txFlag,
    FL: flFlag,
    IL: ilFlag,
    WA: waFlag,
    GA: gaFlag,
    CO: coFlag,
    AZ: azFlag,
    NV: nvFlag,
    MA: maFlag,
    PA: paFlag,
    OH: ohFlag,
    MI: miFlag,
    NC: ncFlag,
    OR: orFlag,
    VA: vaFlag,
    MN: mnFlag,
    // Add more states as needed
  };

  return stateFlags[stateCode] || usFlag; // default flag if missing
}
