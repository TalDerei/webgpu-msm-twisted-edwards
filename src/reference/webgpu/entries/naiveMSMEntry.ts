import { ExtPointType } from "@noble/curves/abstract/edwards";
import { FieldMath } from "../../utils/FieldMath";
import { U256WGSL } from "../wgsl/U256";
import { CurveWGSL } from "../wgsl/Curve";
import { FieldModulusWGSL } from "../wgsl/FieldModulus";
import { WORKGROUP_SIZE } from "../params";
import { u32ArrayToBigInts } from "../utils";
import { IEntryInfo, IGPUInput, IGPUResult, IShaderCode, multipassEntryCreator } from "./multipassEntryCreator";
import { GPUExecution } from "./multipassEntryCreator";

export const naive_msm = async (flattenedPoints: Uint32Array, scalars: Uint32Array): Promise<{x: bigint, y: bigint}> => {
  const [execution, entryInfo] = point_mul_multipass_info(
    flattenedPoints.length / 16,
    flattenedPoints,
    scalars,
    true);

  const bufferResult = await multipassEntryCreator(execution, entryInfo);
  const bigIntResult = u32ArrayToBigInts(bufferResult || new Uint32Array(0));

  const fieldMath = new FieldMath();
  const pointArray: ExtPointType[] = [];

  // convert big int result to extended points
  for (let i = 0; i < bigIntResult.length; i += 4) {
    const x = bigIntResult[i];
    const y = bigIntResult[i + 1];
    const t = bigIntResult[i + 2];
    const z = bigIntResult[i + 3];
    const point = fieldMath.createPoint(x, y, t, z);
    pointArray.push(point);
  }

  const affineResult = fieldMath.addPoints(pointArray);
  return {x: affineResult.x, y: affineResult.y};
}

export const point_mul_multipass_info = (
  numInputs: number,
  affinePoints: Uint32Array,
  scalars: Uint32Array,
  useInputs = true,
): [GPUExecution[], IEntryInfo] => {
  const baseModules = [U256WGSL, FieldModulusWGSL, CurveWGSL];
  const affinePointsBufferSize = Uint32Array.BYTES_PER_ELEMENT * numInputs * 8 * 2; // 2 fields per affine point
  const scalarsBufferSize = Uint32Array.BYTES_PER_ELEMENT * numInputs * 8;
  const pointsBufferSize = Uint32Array.BYTES_PER_ELEMENT * numInputs * 8 * 4; // 4 fields per point

  const calcExtendedPointsEntry = `
    @group(0) @binding(0)
    var<storage, read> input1: array<AffinePoint>;
    @group(0) @binding(1)
    var<storage, read_write> output: array<Point>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
      @builtin(global_invocation_id) global_id : vec3<u32>
    ) {
      var p1 = input1[global_id.x];
      var p1_t = field_multiply(p1.x, p1.y);
      var z = U256_ONE;
      var ext_p1 = Point(p1.x, p1.y, p1_t, z);

      output[global_id.x] = ext_p1;
    }
  `;

  const mulPointFirstStepEntry = `
    @group(0) @binding(0)
    var<storage, read> points: array<Point>;
    @group(0) @binding(1)
    var<storage, read> scalars: Fields;
    @group(0) @binding(2)
    var<storage, read_write> output: array<Point>;
    @group(0) @binding(3)
    var<storage, read_write> updatedScalars: Fields;
    @group(0) @binding(4)
    var<storage, read_write> newTemps: array<Point>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
      @builtin(global_invocation_id) global_id : vec3<u32>
    ) {
      var point = points[global_id.x];
      var scalar = scalars.fields[global_id.x];

      var multiplied = mul_point_64_bits_start(point, scalar);
      output[global_id.x] = multiplied.result;
      updatedScalars.fields[global_id.x] = multiplied.scalar;
      newTemps[global_id.x] = multiplied.temp;
    }
  `;

  const mulPointIntermediateStepEntry = `
    @group(0) @binding(0)
    var<storage, read> points: array<Point>;
    @group(0) @binding(1)
    var<storage, read> scalars: Fields;
    @group(0) @binding(2)
    var<storage, read> prevTemps: array<Point>;
    @group(0) @binding(3)
    var<storage, read_write> output: array<Point>;
    @group(0) @binding(4)
    var<storage, read_write> updatedScalars: Fields;
    @group(0) @binding(5)
    var<storage, read_write> newTemps: array<Point>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
      @builtin(global_invocation_id) global_id : vec3<u32>
    ) {
      var point = points[global_id.x];
      var scalar = scalars.fields[global_id.x];
      var temp = prevTemps[global_id.x];
      var multipliedIntermediate = mul_point_64_bits(point, scalar, temp);
      output[global_id.x] = multipliedIntermediate.result;
      updatedScalars.fields[global_id.x] = multipliedIntermediate.scalar;
      newTemps[global_id.x] = multipliedIntermediate.temp;
    }
  `;

  const mulPointFinalStepEntry = `
    @group(0) @binding(0)
    var<storage, read> points: array<Point>;
    @group(0) @binding(1)
    var<storage, read> scalars: Fields;
    @group(0) @binding(2)
    var<storage, read> prevTemps: array<Point>;
    @group(0) @binding(3)
    var<storage, read_write> output: array<Point>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
      @builtin(global_invocation_id) global_id : vec3<u32>
    ) {
      var point = points[global_id.x];
      var scalar = scalars.fields[global_id.x];
      var temp = prevTemps[global_id.x];
      var multiplied = mul_point_64_bits(point, scalar, temp);
      output[global_id.x] = multiplied.result;
    }
  `;

  const inverseStepEntry = `
    @group(0) @binding(0)
    var<storage, read> mulPoints: array<Point>;
    @group(0) @binding(1)
    var<storage, read_write> output: array<Point>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
      @builtin(global_invocation_id) global_id : vec3<u32>
    ) {
      var point = mulPoints[global_id.x];

      output[global_id.x] = point;
    }
  `;

  const executionSteps: GPUExecution[] = [];

  // Step 1: Calculate extended points
  const calcExtendedPointsShader: IShaderCode = {
    code: [...baseModules, calcExtendedPointsEntry].join("\n"),
    entryPoint: "main"
  }
  const calcExtendedPointsInputs: IGPUInput = {
    inputBufferTypes: ["read-only-storage"],
    inputBufferSizes: [affinePointsBufferSize],
    inputBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST],
    mappedInputs: useInputs
      ? new Map<number, Uint32Array>([[0, new Uint32Array(affinePoints)]])
      : undefined
  }
  const calcExtendedPointsResult: IGPUResult = {
    resultBufferTypes: ["storage"],
    resultBufferSizes: [pointsBufferSize],
    resultBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC]
  }
  const calcExtendedPointsStep = new GPUExecution(calcExtendedPointsShader, calcExtendedPointsInputs, calcExtendedPointsResult);
  executionSteps.push(calcExtendedPointsStep);

  // Step 2: Multiply points by scalars
  const firstMulPointShader: IShaderCode = {
    code: [...baseModules, mulPointFirstStepEntry].join("\n"),
    entryPoint: "main"
  }
  const firstMulPointInputs: IGPUInput = {
    inputBufferTypes: ["read-only-storage", "read-only-storage"],
    inputBufferSizes: [pointsBufferSize, scalarsBufferSize],
    inputBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST],
    mappedInputs: new Map<number, Uint32Array>([[1, new Uint32Array(scalars)]])
  }
  const firstMulPointOutputs: IGPUResult = {
    resultBufferTypes: ["storage", "storage", "storage"],
    resultBufferSizes: [pointsBufferSize, scalarsBufferSize, pointsBufferSize],
    resultBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC]
  }
  const firstMulPointStep = new GPUExecution(firstMulPointShader, firstMulPointInputs, firstMulPointOutputs);
  executionSteps.push(firstMulPointStep);
  for (let i = 0; i < 2; i++) {
    const multPointShader: IShaderCode = {
      code: [...baseModules, mulPointIntermediateStepEntry].join("\n"),
      entryPoint: "main"
    }
    const mulPointInputs: IGPUInput = {
      inputBufferTypes: ["read-only-storage", "read-only-storage", "read-only-storage"],
      inputBufferSizes: [pointsBufferSize, scalarsBufferSize, pointsBufferSize],
      inputBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST]
    }
    const mulPointResult: IGPUResult = {
      resultBufferTypes: ["storage", "storage", "storage"],
      resultBufferSizes: [pointsBufferSize, scalarsBufferSize, pointsBufferSize],
      resultBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC]
    }
    const mulPointStep = new GPUExecution(multPointShader, mulPointInputs, mulPointResult);
    executionSteps.push(mulPointStep);
  }
  const finalMultPointShader: IShaderCode = {
    code: [...baseModules, mulPointFinalStepEntry].join("\n"),
    entryPoint: "main"
  }
  const finalMulPointInputs: IGPUInput = {
    inputBufferTypes: ["read-only-storage", "read-only-storage", "read-only-storage"],
    inputBufferSizes: [pointsBufferSize, scalarsBufferSize, pointsBufferSize],
    inputBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST]
  }
  const finalMulPointResult: IGPUResult = {
    resultBufferTypes: ["storage"],
    resultBufferSizes: [pointsBufferSize],
    resultBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC]
  }
  const finalMulPointStep = new GPUExecution(finalMultPointShader, finalMulPointInputs, finalMulPointResult);
  executionSteps.push(finalMulPointStep);

  // Step 3: Inverse and multiply points
  const inverseShader: IShaderCode = {
    code: [...baseModules, inverseStepEntry].join("\n"),
    entryPoint: "main"
  }
  const inverseInputs: IGPUInput = {
    inputBufferTypes: ["read-only-storage"],
    inputBufferSizes: [pointsBufferSize],
    inputBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST]
  }
  const inverseResult: IGPUResult = {
    resultBufferTypes: ["storage"],
    resultBufferSizes: [pointsBufferSize],
    resultBufferUsages: [GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC]
  }
  const inverseStep = new GPUExecution(inverseShader, inverseInputs, inverseResult);
  executionSteps.push(inverseStep);

  const entryInfo: IEntryInfo = {
    numInputs: numInputs,
    outputSize: pointsBufferSize
  }

  return [executionSteps, entryInfo];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).naive_msm = naive_msm;
