/// <reference types="jest" />
import dotenv from "dotenv";

dotenv.config({ path: ".env.test" });
jest.setTimeout(120000);
