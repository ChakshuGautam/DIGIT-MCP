/**
 * Guided city setup flow — mirrors the leadership demo script.
 *
 * Tests whether Claude can set up a complete city for grievance management
 * from natural language instructions, then run the full complaint lifecycle.
 *
 * 5 steps (~4-5 minutes):
 * 1. Set up city: tenant, boundaries, workflow, employees
 * 2. File a citizen complaint
 * 3. Assign the complaint
 * 4. Resolve the complaint
 * 5. Cleanup test data
 *
 * Each prompt is self-contained. Context (city name, complaint ID) is passed
 * between steps in the prompt text.
 */

import {
  sendPrompt,
  assertToolCalled,
  assertSuccess,
  getToolResult,
  getAllToolResults,
  assert,
  logStep,
  logToolCalls,
  logCost,
  type TurnResult,
} from "../helpers.js";

export const name = "guided-setup";
export const description = "Guided city setup → file complaint → assign → resolve → cleanup";
export const estimatedSeconds = 300;

/** Check if any MCP tool (not built-in) was called. */
function assertMcpToolUsed(result: TurnResult): void {
  const mcpCalls = result.toolCalls.filter((tc) => tc.name.startsWith("mcp__"));
  assert(
    mcpCalls.length > 0,
    `Expected at least one MCP tool call. Called: [${result.toolCalls.map((tc) => tc.name).join(", ")}]`,
  );
}

/** Extract tool short name from qualified name. */
function shortName(qualifiedName: string): string {
  const parts = qualifiedName.split("__");
  return parts[parts.length - 1];
}

export async function run(): Promise<void> {
  // Unique IDs for this run
  const RUN_ID = Date.now() % 100000;
  const CITY = `pg.gs${RUN_ID}`;
  const LOCALITY = `LOC_GS_${RUN_ID}`;
  const GRO_PHONE = `98${String(RUN_ID).padStart(8, "0")}`;
  const LME_PHONE = `91${String(RUN_ID).padStart(8, "0")}`;
  const CITIZEN_PHONE = `70${String(RUN_ID).padStart(8, "0")}`;

  let totalCost = 0;
  let complaintId: string | null = null;

  console.log(`        City: ${CITY}, Locality: ${LOCALITY}`);

  try {
    // -------------------------------------------------------------------
    // Step 1: Set up the city — tenant, boundaries, workflow, employees
    // -------------------------------------------------------------------
    logStep(1, 5, `Setting up new city ${CITY}...`);

    const setup = await sendPrompt(
      `I want to set up a new city called "GS Test City ${RUN_ID}" for citizen grievance management.\n\n` +
      `Here's what I need:\n` +
      `- Create it as tenant ${CITY} under pg (schema: tenant.tenants, unique identifier: Tenant.${CITY})\n` +
      `- Set up a boundary hierarchy (Country > State > District > City > Ward > Locality) ` +
      `with boundary codes: COUNTRY_GS_${RUN_ID}, STATE_GS_${RUN_ID}, DISTRICT_GS_${RUN_ID}, ` +
      `CITY_GS_${RUN_ID}, WARD_GS_${RUN_ID}, and ${LOCALITY} as the locality\n` +
      `- Make sure the PGR workflow exists (copy from pg if needed)\n` +
      `- Create a Grievance Routing Officer: Rajesh Kumar, phone ${GRO_PHONE}, ` +
      `roles EMPLOYEE + GRO + DGRO, department DEPT_1, designation DESIG_1, ` +
      `jurisdiction type City boundary ${CITY}\n` +
      `- Create a field worker: Priya S, phone ${LME_PHONE}, ` +
      `roles EMPLOYEE + PGR_LME, department DEPT_1, designation DESIG_1, ` +
      `jurisdiction type City boundary ${CITY}\n\n` +
      `Do everything needed to make this city ready for PGR complaints.`,
      { maxTurns: 25 },
    );

    logToolCalls(setup);
    logCost(setup);
    totalCost += setup.costUsd;

    // Verify multiple MCP tools were called for the setup
    assertMcpToolUsed(setup);

    const toolNames = setup.toolCalls.map((tc) => shortName(tc.name));
    console.log(`        Setup called ${setup.toolCalls.length} tools across ${setup.numTurns} turns`);

    // Verify key setup tools were called
    const hasTenantCreate = toolNames.some((n) =>
      n === "mdms_create" || n === "validate_tenant" || n === "mdms_search",
    );
    const hasBoundaryCreate = toolNames.some((n) => n === "boundary_create");
    const hasEmployeeCreate = toolNames.some((n) => n === "employee_create");

    assert(hasTenantCreate, `Expected tenant creation tool. Tools: [${toolNames.join(", ")}]`);
    assert(hasBoundaryCreate, `Expected boundary_create. Tools: [${toolNames.join(", ")}]`);

    // Employee creation may hit the known HRMS bug
    if (!hasEmployeeCreate) {
      console.log(`        WARNING: employee_create not called — may need separate step`);
    }

    // Check for HRMS employee creation failures (known bug)
    const empResults = setup.toolResults
      .filter((r) => shortName(r.toolName) === "employee_create")
      .map((r) => r.parsed);
    const empSuccess = empResults.filter((r) => r?.success === true);
    const empFailed = empResults.filter((r) => r?.success === false);

    if (empSuccess.length > 0) {
      console.log(`        Employees created: ${empSuccess.length} succeeded, ${empFailed.length} failed`);
    }
    if (empFailed.length > 0) {
      const firstError = JSON.stringify(empFailed[0]).slice(0, 200);
      if (firstError.includes("getUser()") || firstError.includes("NPE") || firstError.includes("null")) {
        console.log(`        Known HRMS bug: ${firstError}`);
      } else {
        console.log(`        Employee creation errors: ${firstError}`);
      }
    }

    // -------------------------------------------------------------------
    // Step 2: File a citizen complaint
    // -------------------------------------------------------------------
    logStep(2, 5, `Filing complaint in ${CITY}...`);

    const fileComplaint = await sendPrompt(
      `A citizen named Ravi Kumar (phone ${CITIZEN_PHONE}) wants to report ` +
      `that a streetlight is not working near Anna Nagar in ${CITY}. ` +
      `File this complaint using locality code ${LOCALITY}. ` +
      `Service code: StreetLightNotWorking.`,
    );

    logToolCalls(fileComplaint);
    logCost(fileComplaint);
    totalCost += fileComplaint.costUsd;
    assertToolCalled(fileComplaint, "pgr_create");
    assertSuccess(fileComplaint, "pgr_create");

    const createResult = getToolResult(fileComplaint, "pgr_create");
    const complaint = createResult.complaint as Record<string, unknown> | undefined;
    complaintId = (createResult.serviceRequestId as string) ??
      (complaint?.serviceRequestId as string);
    assert(
      typeof complaintId === "string" && complaintId.length > 0,
      `Expected complaint ID, got: ${JSON.stringify(createResult).slice(0, 300)}`,
    );
    console.log(`        Complaint filed: ${complaintId}`);

    // -------------------------------------------------------------------
    // Step 3: Assign the complaint
    // -------------------------------------------------------------------
    logStep(3, 5, `Assigning complaint ${complaintId}...`);

    const assign = await sendPrompt(
      `Assign PGR complaint ${complaintId} in ${CITY}. Let the system auto-route it.`,
    );

    logToolCalls(assign);
    logCost(assign);
    totalCost += assign.costUsd;
    assertToolCalled(assign, "pgr_update");
    assertSuccess(assign, "pgr_update");

    const assignResult = getToolResult(assign, "pgr_update");
    const assignComplaint = assignResult.complaint as Record<string, unknown> | undefined;
    const assignStatus = (assignResult.newStatus as string) ??
      (assignResult.applicationStatus as string) ??
      (assignComplaint?.newStatus as string) ??
      (assignComplaint?.status as string);
    assert(
      assignStatus === "PENDINGATLME",
      `Expected PENDINGATLME after assign, got: ${JSON.stringify(assignResult).slice(0, 300)}`,
    );
    console.log(`        Assigned, status: ${assignStatus}`);

    // -------------------------------------------------------------------
    // Step 4: Resolve the complaint
    // -------------------------------------------------------------------
    logStep(4, 5, `Resolving complaint ${complaintId}...`);

    const resolve = await sendPrompt(
      `Resolve PGR complaint ${complaintId} in ${CITY}. The streetlight has been repaired.`,
    );

    logToolCalls(resolve);
    logCost(resolve);
    totalCost += resolve.costUsd;
    assertToolCalled(resolve, "pgr_update");
    assertSuccess(resolve, "pgr_update");

    const resolveResult = getToolResult(resolve, "pgr_update");
    const resolveComplaint = resolveResult.complaint as Record<string, unknown> | undefined;
    const resolveStatus = (resolveResult.newStatus as string) ??
      (resolveResult.applicationStatus as string) ??
      (resolveComplaint?.newStatus as string) ??
      (resolveComplaint?.status as string);
    assert(
      resolveStatus === "RESOLVED",
      `Expected RESOLVED after resolve, got: ${JSON.stringify(resolveResult).slice(0, 300)}`,
    );
    console.log(`        Resolved, status: ${resolveStatus}`);

    console.log(`        Total flow cost: $${totalCost.toFixed(4)}`);
  } finally {
    // -------------------------------------------------------------------
    // Step 5: Cleanup (best effort — don't fail the test if cleanup fails)
    // -------------------------------------------------------------------
    logStep(5, 5, `Cleaning up ${CITY}...`);

    try {
      const cleanup = await sendPrompt(
        `Clean up tenant ${CITY}: deactivate all MDMS data and users.`,
        { maxTurns: 5 },
      );
      logToolCalls(cleanup);
      logCost(cleanup);
      totalCost += cleanup.costUsd;
      console.log(`        Cleanup completed`);
    } catch (err) {
      console.log(`        Cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
