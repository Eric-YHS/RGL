import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { ExperimentConfig, ExperimentState, LightColor } from "../experiment/types";
import { createGrassTexture } from "./proceduralTextures";

type LampVisual = {
  bulb: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  glow: THREE.PointLight;
  halo: THREE.Sprite;
  haloBaseScale: number;
  onColor: number;
  offColor: number;
};

type TrafficLightMesh = {
  index: number;
  group: THREE.Group;
  red: LampVisual[];
  green: LampVisual[];
};

export class World3D {
  private readonly config: ExperimentConfig;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly ssaoPass: SSAOPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly fxaaPass: ShaderPass;
  private readonly haloTexture: THREE.Texture;
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly atmosphereColor: THREE.Color;
  private readonly fogMode: boolean;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private dpr: number = 1;
  private disposed: boolean = false;

  private readonly spacing: number = 56;
  private readonly routeLength: number;

  private readonly avatar: THREE.Group;
  private readonly trafficLights: TrafficLightMesh[] = [];

  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredCameraPos = new THREE.Vector3();
  private readonly desiredCameraTarget = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, config: ExperimentConfig) {
    this.config = config;
    this.routeLength = this.config.numLights * this.spacing;
    this.fogMode = this.config.revealMode === "sequential";

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance"
    });
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.fogMode ? 1.08 : 0.85;

    this.scene = new THREE.Scene();
    // Fog mode uses a warm neutral haze for a natural soft-fog look.
    this.atmosphereColor = new THREE.Color(this.fogMode ? 0xd6dde6 : 0x9fc2dc);
    this.scene.background = this.atmosphereColor;
    this.haloTexture = this.createGlowTexture();
    this.ownedTextures.push(this.haloTexture);

    // 使用线性雾，让近处清晰，远处平滑过渡到雾色
    this.scene.fog = this.fogMode ? new THREE.Fog(this.atmosphereColor, 20, 250) : null;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 520);
    this.camera.position.set(0, 14, -18);
    this.cameraTarget.set(0, 1.2, 8);
    this.camera.lookAt(this.cameraTarget);

    this.setupEnvironment();
    this.setupLights();
    this.setupGround();
    this.setupStreetscape();
    this.setupBuildings();
    this.avatar = this.createAvatar();
    this.avatar.scale.setScalar(1.25);
    this.scene.add(this.avatar);
    this.setupTrafficLights();

    // Post-processing (写实：SSAO + Bloom + FXAA)
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.dpr);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.ssaoPass = new SSAOPass(this.scene, this.camera, 1, 1);
    this.ssaoPass.output = 0; // Default
    this.ssaoPass.kernelRadius = this.fogMode ? 0.9 : 1.6;
    this.ssaoPass.minDistance = 0.01;
    this.ssaoPass.maxDistance = this.fogMode ? 0.045 : 0.08;
    this.composer.addPass(this.ssaoPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.2, 0.95);
    this.composer.addPass(this.bloomPass);

    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaaPass);

    this.resize();
    window.addEventListener("resize", this.resize);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resize);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
        geometries.add(obj.geometry);
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
        else materials.add(mat);
        return;
      }
      if (obj instanceof THREE.Sprite) {
        materials.add(obj.material);
      }
    });

    materials.forEach((m) => m.dispose());
    geometries.forEach((g) => g.dispose());
    this.ownedTextures.forEach((t) => t.dispose());

    this.envTarget?.dispose();
    this.ssaoPass.dispose();
    this.bloomPass.dispose();
    this.fxaaPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  render(state: ExperimentState, progress01: number, nowMs: number): void {
    const z = this.routeLength * progress01;

    // Avatar
    const moving = state.phase === "moving";
    const bob = moving ? Math.sin(nowMs / 1000 * 8.5) * 0.045 : 0;
    this.avatar.position.set(0, -0.075 + bob, z);
    this.avatar.rotation.y = 0;

    // Animate avatar limbs
    const leftArm = this.avatar.getObjectByName("leftArm");
    const rightArm = this.avatar.getObjectByName("rightArm");
    const leftLeg = this.avatar.getObjectByName("leftLeg");
    const rightLeg = this.avatar.getObjectByName("rightLeg");

    if (moving) {
      const swing = Math.sin(nowMs / 1000 * 8.5) * 0.6;
      if (leftArm) leftArm.rotation.x = swing;
      if (rightArm) rightArm.rotation.x = -swing;
      if (leftLeg) leftLeg.rotation.x = -swing;
      if (rightLeg) rightLeg.rotation.x = swing;
    } else {
      if (leftArm) leftArm.rotation.x = 0;
      if (rightArm) rightArm.rotation.x = 0;
      if (leftLeg) leftLeg.rotation.x = 0;
      if (rightLeg) rightLeg.rotation.x = 0;
    }

    // Camera (导航式跟随)
    const waiting = state.phase === "waiting_red";
    const camHeight = waiting ? 12.5 : 13;
    const camBack = waiting ? 16 : 18;
    const camAhead = waiting ? 10 : 16;
    this.desiredCameraPos.set(0, camHeight, z - camBack);
    const targetY = waiting ? 3.0 : 1.2;
    this.desiredCameraTarget.set(0, targetY, z + camAhead);
    this.camera.position.lerp(this.desiredCameraPos, 0.08);
    this.cameraTarget.lerp(this.desiredCameraTarget, 0.1);
    this.camera.lookAt(this.cameraTarget);

    // Traffic lights
    for (const tl of this.trafficLights) {
      tl.group.visible = true;
      const color = this.getTrafficLightColor(state, tl.index);
      const visibility01 = this.getFogTransmittance(tl.group.position);
      this.setLampGroup(tl.red, "red", color, nowMs, tl.index * 2, visibility01);
      this.setLampGroup(tl.green, "green", color, nowMs, tl.index * 2 + 1, visibility01);
    }

    this.composer.render();
  }

  private readonly resize = (): void => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const width = parent ? parent.clientWidth : window.innerWidth;
    const height = parent ? parent.clientHeight : window.innerHeight;

    // Post-processing 开销较大，限制 DPR 保持帧率稳定
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(width, height);

    // SSAO 单独降分辨率（性价比高）
    const ssaoScale = 0.75;
    this.ssaoPass.setSize(
      Math.max(1, Math.round(width * this.dpr * ssaoScale)),
      Math.max(1, Math.round(height * this.dpr * ssaoScale))
    );

    const invW = 1 / Math.max(1, Math.round(width * this.dpr));
    const invH = 1 / Math.max(1, Math.round(height * this.dpr));
    (this.fxaaPass.material as THREE.ShaderMaterial).uniforms["resolution"].value.set(invW, invH);
  };

  private setupEnvironment(): void {
    // Fallback IBL（避免 HDRI 未加载完成前环境反射全黑）
    const fallback = this.createEquirectEnvironmentTexture();
    fallback.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromEquirectangular(fallback);
    this.scene.environment = this.envTarget.texture;
    fallback.dispose();
    pmrem.dispose();

    // HDRI IBL + 背景（写实质感的关键）
    const hdriUrl = "/hdri/daytime.hdr";
    new RGBELoader().load(
      hdriUrl,
      (tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }

        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (!this.fogMode) {
          this.scene.background = tex;
          // 降低非雾天模式下 HDRI 背景的亮度，防止天空过曝
          this.scene.backgroundIntensity = 0.6;
        } else {
          // 雾天模式下，保持纯色背景以匹配雾的颜色，避免远景物体与天空颜色断层
          this.scene.background = this.atmosphereColor;
        }
        this.ownedTextures.push(tex);

        const pmrem2 = new THREE.PMREMGenerator(this.renderer);
        const nextEnv = pmrem2.fromEquirectangular(tex);
        this.envTarget?.dispose();
        this.envTarget = nextEnv;
        this.scene.environment = nextEnv.texture;
        pmrem2.dispose();
      },
      undefined,
      (err) => {
        console.warn(`[World3D] HDRI 加载失败: ${hdriUrl}`, err);
      }
    );
  }

  private createEquirectEnvironmentTexture(): THREE.CanvasTexture {
    const w = 512;
    const h = 256;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    if (!ctx) return tex;

    const top = new THREE.Color(0x4c8ec5);
    const bottom = this.atmosphereColor.clone().lerp(new THREE.Color(0xffffff), 0.28);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `#${top.getHexString()}`);
    grad.addColorStop(1, `#${bottom.getHexString()}`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // soft sun blob (used mainly for reflections)
    const sx = w * 0.72;
    const sy = h * 0.26;
    const sr = w * 0.18;
    const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sun.addColorStop(0, "rgba(255,245,220,0.95)");
    sun.addColorStop(0.25, "rgba(255,220,160,0.28)");
    sun.addColorStop(1, "rgba(255,245,220,0)");
    ctx.fillStyle = sun;
    ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);

    return tex;
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xc8ddf0, 0x5a7a96, this.fogMode ? 0.95 : 0.65);
    hemi.position.set(0, 80, 0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e0, this.fogMode ? 1.25 : 1.1);
    sun.position.set(24, 42, -18);
    sun.castShadow = false;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9ec5e8, this.fogMode ? 0.38 : 0.25);
    fill.position.set(-30, 28, 30);
    this.scene.add(fill);

    // 清晨天空环境光
    const ambient = new THREE.AmbientLight(this.atmosphereColor, this.fogMode ? 0.22 : 0.1);
    this.scene.add(ambient);
  }

  private setupGround(): void {
    const roadWidth = 14;
    const roadHalf = roadWidth / 2;
    const sidewalkWidth = 3.4;
    const length = this.routeLength + 220;
    const centerZ = this.routeLength / 2;

    const aniso = this.renderer.capabilities.getMaxAnisotropy();

    const grassTex = createGrassTexture({ seed: 13 });
    grassTex.anisotropy = aniso;
    grassTex.repeat.set(140 / 10, (length + 120) / 10);
    this.ownedTextures.push(grassTex);

    const loader = new THREE.TextureLoader();

    // Road (Poly Haven, 1K)
    const asphaltDiff = loader.load("/textures/polyhaven/asphalt_05/asphalt_05_diff_1k.jpg");
    asphaltDiff.colorSpace = THREE.SRGBColorSpace;
    const asphaltNormal = loader.load("/textures/polyhaven/asphalt_05/asphalt_05_nor_gl_1k.png");
    asphaltNormal.colorSpace = THREE.NoColorSpace;
    const asphaltArm = loader.load("/textures/polyhaven/asphalt_05/asphalt_05_arm_1k.jpg");
    asphaltArm.colorSpace = THREE.NoColorSpace;
    for (const t of [asphaltDiff, asphaltNormal, asphaltArm]) {
      t.anisotropy = aniso;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(roadWidth / 6, length / 6);
    }
    this.ownedTextures.push(asphaltDiff, asphaltNormal, asphaltArm);

    // Sidewalk (Poly Haven, 1K)
    const pavementDiff = loader.load(
      "/textures/polyhaven/concrete_pavement/concrete_pavement_diff_1k.jpg"
    );
    pavementDiff.colorSpace = THREE.SRGBColorSpace;
    const pavementNormal = loader.load(
      "/textures/polyhaven/concrete_pavement/concrete_pavement_nor_gl_1k.png"
    );
    pavementNormal.colorSpace = THREE.NoColorSpace;
    const pavementArm = loader.load(
      "/textures/polyhaven/concrete_pavement/concrete_pavement_arm_1k.jpg"
    );
    pavementArm.colorSpace = THREE.NoColorSpace;
    for (const t of [pavementDiff, pavementNormal, pavementArm]) {
      t.anisotropy = aniso;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(sidewalkWidth / 2.2, length / 2.2);
    }
    this.ownedTextures.push(pavementDiff, pavementNormal, pavementArm);

    // Grass / ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(140, length + 120),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: grassTex,
        roughness: 1.0,
        metalness: 0
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.03, centerZ);
    this.scene.add(ground);

    // Road
    const roadGeo = new THREE.PlaneGeometry(roadWidth, length);
    roadGeo.setAttribute("uv2", roadGeo.attributes.uv);
    const roadMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: asphaltDiff,
      normalMap: asphaltNormal,
      aoMap: asphaltArm,
      roughnessMap: asphaltArm,
      metalnessMap: asphaltArm,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.55
    });
    roadMat.normalScale.setScalar(0.85);
    roadMat.aoMapIntensity = 0.65;
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.0, centerZ);
    this.scene.add(road);

    // Sidewalks
    const sidewalkGeo = new THREE.PlaneGeometry(sidewalkWidth, length);
    sidewalkGeo.setAttribute("uv2", sidewalkGeo.attributes.uv);
    const sidewalkMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: pavementDiff,
      normalMap: pavementNormal,
      aoMap: pavementArm,
      roughnessMap: pavementArm,
      metalnessMap: pavementArm,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.38
    });
    sidewalkMat.normalScale.setScalar(0.7);
    sidewalkMat.aoMapIntensity = 0.7;
    const sidewalkL = new THREE.Mesh(sidewalkGeo, sidewalkMat);
    sidewalkL.rotation.x = -Math.PI / 2;
    sidewalkL.position.set(-(roadHalf + sidewalkWidth / 2), 0.008, centerZ);
    this.scene.add(sidewalkL);

    const sidewalkR = new THREE.Mesh(sidewalkGeo, sidewalkMat);
    sidewalkR.rotation.x = -Math.PI / 2;
    sidewalkR.position.set(roadHalf + sidewalkWidth / 2, 0.008, centerZ);
    this.scene.add(sidewalkR);

    // Curb strips
    const curbGeo = new THREE.PlaneGeometry(0.32, length);
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0x9aa5af,
      roughness: 0.92,
      metalness: 0.02
    });
    const curbL = new THREE.Mesh(curbGeo, curbMat);
    curbL.rotation.x = -Math.PI / 2;
    curbL.position.set(-(roadHalf + 0.16), 0.006, centerZ);
    this.scene.add(curbL);

    const curbR = new THREE.Mesh(curbGeo, curbMat);
    curbR.rotation.x = -Math.PI / 2;
    curbR.position.set(roadHalf + 0.16, 0.006, centerZ);
    this.scene.add(curbR);

    // Edge lines
    const edgeGeo = new THREE.PlaneGeometry(0.12, length);
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
      transparent: true,
      opacity: 0.22
    });
    const edgeL = new THREE.Mesh(edgeGeo, edgeMat);
    edgeL.rotation.x = -Math.PI / 2;
    edgeL.position.set(-(roadHalf - 0.35), 0.01, centerZ);
    this.scene.add(edgeL);

    const edgeR = new THREE.Mesh(edgeGeo, edgeMat);
    edgeR.rotation.x = -Math.PI / 2;
    edgeR.position.set(roadHalf - 0.35, 0.01, centerZ);
    this.scene.add(edgeR);

    // Center dashed line
    const lineGeo = new THREE.PlaneGeometry(0.25, 2.2);
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      opacity: 0.8
    });

    const dashCount = Math.ceil((this.routeLength + 200) / 3.2);
    const dashes = new THREE.InstancedMesh(lineGeo, lineMat, dashCount);
    const m = new THREE.Matrix4();
    let idx = 0;
    const startZ = -40;
    for (let i = 0; i < dashCount; i++) {
      const z = startZ + i * 3.2;
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(0, 0.012, z);
      dashes.setMatrixAt(idx, m);
      idx += 1;
    }
    dashes.instanceMatrix.needsUpdate = true;
    this.scene.add(dashes);
  }

  private setupStreetscape(): void {
    const roadWidth = 14;
    const roadHalf = roadWidth / 2;
    const sidewalkWidth = 3.4;

    const startZ = -60;
    const endZ = this.routeLength + 80;

    let seed = 24681357;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    // Trees
    const treeStep = 18;
    const treeBands = Math.max(16, Math.floor((endZ - startZ) / treeStep));
    const treeCount = treeBands * 2;
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, 2.2, 8);
    const leavesGeo = new THREE.SphereGeometry(0.9, 12, 10);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x6a4b3a,
      roughness: 0.95,
      metalness: 0
    });
    const leavesMat = new THREE.MeshStandardMaterial({
      color: 0x4aa84f,
      roughness: 0.95,
      metalness: 0,
      emissive: 0x0c2a12,
      emissiveIntensity: 0.22
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const leaves = new THREE.InstancedMesh(leavesGeo, leavesMat, treeCount);

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let tIdx = 0;
    const treeBaseX = roadHalf + sidewalkWidth + 2.1;
    for (let i = 0; i < treeBands; i++) {
      for (const side of [-1, 1]) {
        const z = startZ + i * treeStep + (random() - 0.5) * 7;
        const x = side * (treeBaseX + random() * 3.2);
        const trunkH = 1.8 + random() * 1.1;
        const sway = (random() - 0.5) * 0.12;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sway);

        // trunk
        p.set(x, trunkH / 2 - 0.02, z);
        s.set(1, trunkH / 2.2, 1);
        m.compose(p, q, s);
        trunks.setMatrixAt(tIdx, m);

        // leaves
        const leafS = 0.85 + random() * 0.35;
        p.set(x, trunkH + 0.55 + random() * 0.25, z);
        s.set(leafS, leafS * (0.9 + random() * 0.25), leafS);
        m.compose(p, q, s);
        leaves.setMatrixAt(tIdx, m);
        tIdx += 1;
      }
    }
    trunks.count = tIdx;
    leaves.count = tIdx;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    this.scene.add(trunks);
    this.scene.add(leaves);

    // Street lamps
    const lampStep = 28;
    const lampCount = Math.max(10, Math.floor((endZ - startZ) / lampStep));
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.07, 3.6, 10);
    const headGeo = new THREE.SphereGeometry(0.13, 12, 10);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x5b6a75,
      roughness: 0.75,
      metalness: 0.35
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      roughness: 0.35,
      metalness: 0,
      emissive: 0xfff1c0,
      emissiveIntensity: 0.7
    });

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampCount);
    const heads = new THREE.InstancedMesh(headGeo, headMat, lampCount);

    const lampX = roadHalf + sidewalkWidth - 0.65;
    for (let i = 0; i < lampCount; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = startZ + i * lampStep + (random() - 0.5) * 6;
      const x = side * lampX;
      const h = 3.35 + random() * 0.55;

      p.set(x, h / 2 - 0.02, z);
      s.set(1, h / 3.6, 1);
      q.set(0, 0, 0, 1);
      m.compose(p, q, s);
      poles.setMatrixAt(i, m);

      p.set(x, h - 0.02, z);
      s.set(1, 1, 1);
      m.compose(p, q, s);
      heads.setMatrixAt(i, m);
    }
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    this.scene.add(poles);
    this.scene.add(heads);
  }

  private setupBuildings(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute("uv2", geo.attributes.uv);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    const loader = new THREE.TextureLoader();

    // Building facade (Poly Haven, 1K)
    const facadeDiff = loader.load(
      "/textures/polyhaven/concrete_tile_facade/concrete_tile_facade_diff_1k.jpg"
    );
    facadeDiff.colorSpace = THREE.SRGBColorSpace;
    const facadeNormal = loader.load(
      "/textures/polyhaven/concrete_tile_facade/concrete_tile_facade_nor_gl_1k.png"
    );
    facadeNormal.colorSpace = THREE.NoColorSpace;
    const facadeArm = loader.load(
      "/textures/polyhaven/concrete_tile_facade/concrete_tile_facade_arm_1k.jpg"
    );
    facadeArm.colorSpace = THREE.NoColorSpace;
    for (const t of [facadeDiff, facadeNormal, facadeArm]) {
      t.anisotropy = aniso;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2.0, 4.0);
    }
    this.ownedTextures.push(facadeDiff, facadeNormal, facadeArm);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: facadeDiff,
      normalMap: facadeNormal,
      roughnessMap: facadeArm,
      metalnessMap: facadeArm,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.35,
      vertexColors: true
    });
    mat.normalScale.setScalar(0.55);

    // windows (暖色发光，避免“建筑全黑”)
    const windowGeo = new THREE.PlaneGeometry(1, 1);
    const windowMat = new THREE.MeshBasicMaterial({
      color: 0xffe3ad,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    windowMat.toneMapped = false;

    const roadHalf = 7;
    const sidewalkWidth = 3.4;
    const streetReserve = 6.8; // sidewalks + street furniture + trees

    const count = Math.min(220, Math.max(60, this.config.numLights * 28));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const maxWindows = count * 240;
    const windows = new THREE.InstancedMesh(windowGeo, windowMat, maxWindows);
    windows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const buildingColor = new THREE.Color();
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const qWin = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);

    let winIdx = 0;

    let seed = 12345;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    for (let i = 0; i < count; i++) {
      const side = random() < 0.5 ? -1 : 1;
      const z = (random() * (this.routeLength + 140)) - 60;
      const w = 2.2 + random() * 6;
      const d = 2.2 + random() * 7;
      const h = 3 + random() * 22;

      // Keep an empty "street band" near the road (sidewalk + props), so the street feels readable.
      const minX = roadHalf + sidewalkWidth + streetReserve + w / 2;
      const x = side * (minX + random() * 26);

      p.set(x, h / 2 - 0.02, z);
      s.set(w, h, d);
      q.set(0, 0, 0, 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);

      // Warm-ish concrete helps separation from blue fog; keep subtle per-building variation.
      const variant = random();
      if (variant < 0.78) {
        const h = 0.085 + random() * 0.025; // warm concrete
        const sat = 0.06 + random() * 0.1;
        const lit = 0.46 + random() * 0.18;
        buildingColor.setHSL(h, sat, lit);
      } else {
        const h = 0.56 + random() * 0.06; // cooler concrete
        const sat = 0.04 + random() * 0.05;
        const lit = 0.45 + random() * 0.17;
        buildingColor.setHSL(h, sat, lit);
      }
      mesh.setColorAt(i, buildingColor);

      // windows on the road-facing facade
      const rows = Math.min(8, Math.max(3, Math.floor(h / 3)));
      const cols = Math.min(5, Math.max(2, Math.floor(d / 2)));
      const litChance = 0.35 + random() * 0.35;
      const marginY = 0.75;
      const marginZ = 0.35;
      const facadeX = x - side * (w / 2 + 0.06);
      qWin.setFromAxisAngle(yAxis, -side * Math.PI / 2);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (random() > litChance) continue;
          if (winIdx >= maxWindows) break;

          const y = marginY + (h - marginY * 2) * ((r + 0.5) / rows);
          const localZ = -d / 2 + marginZ + (d - marginZ * 2) * ((c + 0.5) / cols);
          const winW = 0.25 + random() * 0.12;
          const winH = 0.35 + random() * 0.16;

          p.set(facadeX, y - 0.02, z + localZ);
          s.set(winW, winH, 1);
          m.compose(p, qWin, s);
          windows.setMatrixAt(winIdx, m);
          winIdx += 1;
        }
      }

      // windows on the front/back facades
      const colsZ = Math.min(5, Math.max(2, Math.floor(w / 2)));
      const marginX = 0.35;

      // Front facade (+Z)
      const facadeZFront = z + d / 2 + 0.06;
      qWin.setFromAxisAngle(yAxis, 0);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < colsZ; c++) {
          if (random() > litChance) continue;
          if (winIdx >= maxWindows) break;

          const y = marginY + (h - marginY * 2) * ((r + 0.5) / rows);
          const localX = -w / 2 + marginX + (w - marginX * 2) * ((c + 0.5) / colsZ);
          const winW = 0.25 + random() * 0.12;
          const winH = 0.35 + random() * 0.16;

          p.set(x + localX, y - 0.02, facadeZFront);
          s.set(winW, winH, 1);
          m.compose(p, qWin, s);
          windows.setMatrixAt(winIdx, m);
          winIdx += 1;
        }
      }

      // Back facade (-Z)
      const facadeZBack = z - d / 2 - 0.06;
      qWin.setFromAxisAngle(yAxis, Math.PI);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < colsZ; c++) {
          if (random() > litChance) continue;
          if (winIdx >= maxWindows) break;

          const y = marginY + (h - marginY * 2) * ((r + 0.5) / rows);
          const localX = -w / 2 + marginX + (w - marginX * 2) * ((c + 0.5) / colsZ);
          const winW = 0.25 + random() * 0.12;
          const winH = 0.35 + random() * 0.16;

          p.set(x + localX, y - 0.02, facadeZBack);
          s.set(winW, winH, 1);
          m.compose(p, qWin, s);
          windows.setMatrixAt(winIdx, m);
          winIdx += 1;
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);

    windows.count = winIdx;
    windows.instanceMatrix.needsUpdate = true;
    if (windows.instanceColor) windows.instanceColor.needsUpdate = true;
    windows.computeBoundingSphere();
    this.scene.add(windows);
  }

  private createAvatar(): THREE.Group {
    const g = new THREE.Group();

    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xffd2b3,
      roughness: 0.78,
      metalness: 0.05
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: 0x2b2b2b,
      roughness: 0.9,
      metalness: 0.05
    });
    const shirtMat = new THREE.MeshStandardMaterial({
      color: 0x0fb8e0,
      roughness: 0.75,
      metalness: 0.06
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x1d4e89,
      roughness: 0.86,
      metalness: 0.06
    });
    const shoeMat = new THREE.MeshStandardMaterial({
      color: 0x20262c,
      roughness: 0.92,
      metalness: 0.06
    });
    const bagMat = new THREE.MeshStandardMaterial({
      color: 0x3d5163,
      roughness: 0.85,
      metalness: 0.08
    });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0b0d10 });

    // Head
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.68, 0.02);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 14), skinMat);
    headGroup.add(head);

    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.275, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
      hairMat
    );
    hair.position.set(0, 0.05, 0);
    headGroup.add(hair);

    const eyeGeo = new THREE.SphereGeometry(0.04, 10, 8);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.08, 0.02, 0.22);
    headGroup.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.08, 0.02, 0.22);
    headGroup.add(rightEye);

    g.add(headGroup);

    // Body
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.52, 4, 12), shirtMat);
    body.position.set(0, 1.12, 0);
    g.add(body);

    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.32, 0.12), bagMat);
    bag.position.set(0, 1.12, -0.18);
    g.add(bag);

    // Left Arm
    const armGeo = new THREE.CapsuleGeometry(0.07, 0.42, 4, 10);
    const leftArm = new THREE.Group();
    leftArm.name = "leftArm";
    leftArm.position.set(-0.28, 1.38, 0); // Pivot at shoulder
    const leftArmMesh = new THREE.Mesh(armGeo, skinMat);
    leftArmMesh.position.set(0, -0.28, 0); // Offset from pivot
    leftArm.add(leftArmMesh);
    g.add(leftArm);

    // Right Arm
    const rightArm = new THREE.Group();
    rightArm.name = "rightArm";
    rightArm.position.set(0.28, 1.38, 0); // Pivot at shoulder
    const rightArmMesh = new THREE.Mesh(armGeo, skinMat);
    rightArmMesh.position.set(0, -0.28, 0); // Offset from pivot
    rightArm.add(rightArmMesh);
    g.add(rightArm);

    // Left Leg
    const legGeo = new THREE.CapsuleGeometry(0.08, 0.48, 4, 10);
    const leftLeg = new THREE.Group();
    leftLeg.name = "leftLeg";
    leftLeg.position.set(-0.12, 0.74, 0); // Pivot at hip
    const leftLegMesh = new THREE.Mesh(legGeo, pantsMat);
    leftLegMesh.position.set(0, -0.32, 0); // Offset from pivot
    leftLeg.add(leftLegMesh);
    const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.28), shoeMat);
    leftShoe.position.set(0, -0.62, 0.05);
    leftLeg.add(leftShoe);
    g.add(leftLeg);

    // Right Leg
    const rightLeg = new THREE.Group();
    rightLeg.name = "rightLeg";
    rightLeg.position.set(0.12, 0.74, 0); // Pivot at hip
    const rightLegMesh = new THREE.Mesh(legGeo, pantsMat);
    rightLegMesh.position.set(0, -0.32, 0); // Offset from pivot
    rightLeg.add(rightLegMesh);
    const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.28), shoeMat);
    rightShoe.position.set(0, -0.62, 0.05);
    rightLeg.add(rightShoe);
    g.add(rightLeg);

    // Shadow
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.001, 0);
    g.add(shadow);

    return g;
  }

  private setupTrafficLights(): void {
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x5e6e78,
      roughness: 0.65,
      metalness: 0.35
    });
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x2e3840,
      roughness: 0.55,
      metalness: 0.3
    });
    const backplateMat = new THREE.MeshStandardMaterial({
      color: 0x1e2830,
      roughness: 0.8,
      metalness: 0.15
    });
    // 灯箱边缘轮廓材质，增加立体感
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x8a9aaa,
      roughness: 0.45,
      metalness: 0.4
    });
    const stripeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      opacity: 0.8
    });

    for (let i = 1; i <= this.config.numLights; i++) {
      const group = new THREE.Group();
      group.position.set(0, 0, i * this.spacing);

      const lampsRed: LampVisual[] = [];
      const lampsGreen: LampVisual[] = [];

      // side pole + overhead arm (更像真实路口红绿灯)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5.6, 14), poleMat);
      pole.position.set(-6.4, 2.8, 0.8);
      group.add(pole);

      const arm = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.16, 0.16), poleMat);
      arm.position.set(-3.0, 5.6, 0.8);
      group.add(arm);

      const box = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.0, 0.7), boxMat);
      box.position.set(0.0, 5.25, 0.8);
      group.add(box);

      // 灯箱边框（勾勒轮廓）
      const edgeFrame = new THREE.Mesh(new THREE.BoxGeometry(1.05, 2.1, 0.04), edgeMat);
      edgeFrame.position.set(0.0, 5.25, 0.44);
      group.add(edgeFrame);

      const backplate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.3, 0.16), backplateMat);
      backplate.position.set(0.0, 5.25, 0.55);
      group.add(backplate);

      // overhead lamps (带光晕，视觉更显著)
      lampsRed.push(this.createLamp(group, "red", new THREE.Vector3(0.0, 5.72, 0.38), 0.32));
      lampsGreen.push(
        this.createLamp(group, "green", new THREE.Vector3(0.0, 4.82, 0.38), 0.32)
      );

      // pedestrian-side signal (更靠近视线，避免“看不见红绿灯”)
      const pedPole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 3.4, 12), poleMat);
      pedPole.position.set(5.9, 1.7, -0.8);
      group.add(pedPole);

      const pedBox = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.5, 0.48), boxMat);
      pedBox.position.set(5.9, 3.05, -0.8);
      group.add(pedBox);

      // 行人灯箱边框
      const pedEdge = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.6, 0.04), edgeMat);
      pedEdge.position.set(5.9, 3.05, -1.05);
      group.add(pedEdge);

      const pedBack = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.75, 0.14), backplateMat);
      pedBack.position.set(5.9, 3.05, -1.03);
      group.add(pedBack);

      lampsRed.push(this.createLamp(group, "red", new THREE.Vector3(5.9, 3.42, -1.18), 0.32));
      lampsGreen.push(
        this.createLamp(group, "green", new THREE.Vector3(5.9, 2.68, -1.18), 0.32)
      );

      // stop line marker
      const stopLine = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 0.22),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.85,
          metalness: 0,
          transparent: true,
          opacity: 0.55
        })
      );
      stopLine.rotation.x = -Math.PI / 2;
      stopLine.position.set(0, 0.012, 0);
      group.add(stopLine);

      // crosswalk stripes
      const stripes = new THREE.Group();
      const stripeCount = 9;
      for (let s = 0; s < stripeCount; s++) {
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 1.35), stripeMat);
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(-5.2 + s * 1.3, 0.011, -1.1);
        stripes.add(stripe);
      }
      group.add(stripes);

      this.scene.add(group);
      this.trafficLights.push({ index: i, group, red: lampsRed, green: lampsGreen });
    }
  }

  private createLamp(
    group: THREE.Group,
    which: "red" | "green",
    position: THREE.Vector3,
    radius: number
  ): LampVisual {
    const onColor = which === "red" ? 0xff3340 : 0x52ff5a;
    const offColor = which === "red" ? 0x3b0b10 : 0x10350d;

    const material = new THREE.MeshBasicMaterial({
      color: offColor,
      fog: false,
      transparent: true,
      opacity: 1
    });

    const bulb = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 20), material);
    bulb.position.copy(position);
    group.add(bulb);

    const glow = new THREE.PointLight(which === "red" ? 0xff3340 : 0x52ff5a, 0, 16, 1.8);
    glow.position.copy(position);
    group.add(glow);

    const haloMat = new THREE.SpriteMaterial({
      map: this.haloTexture,
      color: which === "red" ? 0xff3340 : 0x52ff5a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false
    });
    const halo = new THREE.Sprite(haloMat);
    // 相机在 -Z 方向，光晕往相机方向略微偏移，避免被灯箱遮挡形成“方块边缘”
    halo.position.copy(position).add(new THREE.Vector3(0, 0, -0.22));
    const s = radius * 8;
    halo.scale.set(s, s, 1);
    group.add(halo);

    return { bulb, glow, halo, haloBaseScale: s, onColor, offColor };
  }

  private setLampGroup(
    group: LampVisual[],
    which: "red" | "green",
    color: LightColor,
    nowMs: number,
    seed: number,
    visibility01: number
  ): void {
    const on = which === color;
    const t = nowMs / 1000;
    const pulse = on ? 0.06 + 0.06 * Math.sin(t * 6.2 + seed) : 0;
    for (const lamp of group) {
      lamp.bulb.material.color.setHex(on ? lamp.onColor : lamp.offColor);
      lamp.bulb.material.opacity = THREE.MathUtils.clamp(visibility01, 0, 1);
      lamp.glow.intensity = (on ? 4.2 + pulse * 3 : 0) * visibility01;
      lamp.halo.material.opacity = (on ? 0.88 + pulse : 0) * visibility01;
      const scale = on ? lamp.haloBaseScale * (1.18 + pulse * 1.2) : lamp.haloBaseScale;
      lamp.halo.scale.set(scale, scale, 1);
    }
  }

  private createGlowTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const fallback = new THREE.Texture();
      fallback.needsUpdate = true;
      return fallback;
    }

    const center = size / 2;
    const g = ctx.createRadialGradient(center, center, 0, center, center, center);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, "rgba(255,255,255,0.95)");
    g.addColorStop(0.42, "rgba(255,255,255,0.45)");
    g.addColorStop(0.7, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  private getFogTransmittance(position: THREE.Vector3): number {
    if (this.config.revealMode !== "sequential") return 1;

    const fog = this.scene.fog;
    if (!fog) return 1;

    const dist = this.camera.position.distanceTo(position);
    if (fog instanceof THREE.FogExp2) {
      const d = fog.density;
      const t = Math.exp(-d * d * dist * dist);
      return THREE.MathUtils.clamp(t, 0, 1);
    }
    if (fog instanceof THREE.Fog) {
      const t = 1 - (dist - fog.near) / Math.max(1e-6, fog.far - fog.near);
      return THREE.MathUtils.clamp(t, 0, 1);
    }
    return 1;
  }

  private getTrafficLightColor(state: ExperimentState, index: number): LightColor {
    if (state.phase === "idle") return "red";
    if (state.phase === "finished") {
      const outcome = state.passedOutcome[index];
      if (outcome === "green") return "green";
      return "red";
    }
    if (index < state.lightIndex) {
      const outcome = state.passedOutcome[index];
      return outcome === "green" ? "green" : "red";
    }
    if (index > state.lightIndex) return "red";
    // current
    if (state.phase === "waiting_red") return state.currentLightColor;
    return "red";
  }
}
