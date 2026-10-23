/**
 * Whisk API 클라이언트 래퍼
 * 
 * - 쿠키 기반 인증
 * - 프로젝트 생성 및 참조 이미지 관리
 * - 참조 기반 이미지 생성
 */
import { Whisk, Media, Project } from '@rohitaryal/whisk-api';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ReferenceSet {
    subject?: string;  // 피사체 이미지 경로 또는 base64
    scene?: string;    // 장면 이미지 경로 또는 base64
    style?: string;    // 스타일 이미지 경로 또는 base64
}

export interface GenerationResult {
    success: boolean;
    imageBase64?: string;
    mediaId?: string;
    error?: string;
}

/** 프로젝트 내 미디어 정보 */
export interface ProjectMedia {
    name: string;
    createTime: string;
    mediaCategory: 'MEDIA_CATEGORY_SUBJECT' | 'MEDIA_CATEGORY_SCENE' | 'MEDIA_CATEGORY_STYLE';
    mediaGenerationId: string;
    isUserUploaded: boolean;
    prompt?: string;
    mediaKey?: string;
}

/** 프로젝트 워크플로우 응답 */
export interface ProjectWorkflowResponse {
    media: ProjectMedia[];
}

export class WhiskClient {
    private whisk: Whisk;
    private currentProject: Project | null = null;

    constructor(cookieString: string) {
        this.whisk = new Whisk(cookieString);
    }

    /**
     * 쿠키 파일에서 클라이언트 생성
     */
    static fromCookieFile(cookiePath: string): WhiskClient {
        if (!fs.existsSync(cookiePath)) {
            throw new Error(`Cookie file not found: ${cookiePath}`);
        }

        let cookieContent = fs.readFileSync(cookiePath, 'utf-8').trim();

        // JSON 배열 형식인 경우 변환
        try {
            const parsed = JSON.parse(cookieContent);
            if (Array.isArray(parsed)) {
                // 필수 인증 쿠키만 필터링 (전체 99개 쿠키를 보내면 HTTP 431 발생)
                const essentialCookieNames = new Set([
                    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
                    '__Secure-1PSID', '__Secure-3PSID',
                    '__Secure-1PAPISID', '__Secure-3PAPISID',
                    '__Secure-1PSIDTS', '__Secure-3PSIDTS',
                    'NID', 'SIDCC', '__Secure-ENID',
                    '1P_JAR', 'AEC',
                    '__Secure-1PSIDCC', '__Secure-3PSIDCC',
                ]);
                const filtered = parsed.filter((c: any) => essentialCookieNames.has(c.name));
                cookieContent = (filtered.length > 0 ? filtered : parsed).map((c: any) => `${c.name}=${c.value}`).join('; ');
            } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                cookieContent = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; ');
            }
        } catch {
            // 이미 문자열 형식일 경우 그대로 사용
        }

        return new WhiskClient(cookieContent);
    }

    /**
     * 새 프로젝트 생성
     */
    async createProject(name: string = 'Storyboard-Project'): Promise<Project> {
        console.log(`📁 Creating project: ${name}`);
        this.currentProject = await this.whisk.newProject(name);
        console.log(`   Project ID: ${this.currentProject.projectId}`);
        return this.currentProject;
    }

    /**
     * 이미지 파일 또는 base64를 raw base64로 변환
     */
    private async loadImageAsBase64(imagePathOrBase64: string): Promise<string> {
        // 이미 base64인 경우
        if (imagePathOrBase64.startsWith('data:') || !imagePathOrBase64.includes('.')) {
            return imagePathOrBase64.replace(/^data:image\/\w+;base64,/, '');
        }

        // 파일 경로인 경우
        if (!fs.existsSync(imagePathOrBase64)) {
            throw new Error(`Image file not found: ${imagePathOrBase64}`);
        }

        const buffer = fs.readFileSync(imagePathOrBase64);
        return buffer.toString('base64');
    }

    /**
     * 참조 이미지 설정 (피사체, 장면, 스타일)
     */
    async setupReferences(refs: ReferenceSet): Promise<void> {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }

        if (refs.subject) {
            console.log('🎭 Adding subject reference...');
            const base64 = await this.loadImageAsBase64(refs.subject);
            await this.currentProject.addSubject(base64);
            console.log('   ✅ Subject added');
        }

        if (refs.scene) {
            console.log('🏞️ Adding scene reference...');
            const base64 = await this.loadImageAsBase64(refs.scene);
            await this.currentProject.addScene(base64);
            console.log('   ✅ Scene added');
        }

        if (refs.style) {
            console.log('🎨 Adding style reference...');
            const base64 = await this.loadImageAsBase64(refs.style);
            await this.currentProject.addStyle(base64);
            console.log('   ✅ Style added');
        }
    }

    /**
     * 피사체(Subject) 참조 이미지 모두 제거
     * 다른 캐릭터로 전환할 때 사용
     */
    clearSubjects(): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        // TypeScript readonly이지만 런타임에서는 mutable
        (this.currentProject.subjects as any[]).length = 0;
        console.log('🧹 Subjects cleared');
    }

    /**
     * 장면(Scene) 참조 이미지 모두 제거
     */
    clearScenes(): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        (this.currentProject.scenes as any[]).length = 0;
        console.log('🧹 Scenes cleared');
    }

    /**
     * 스타일(Style) 참조 이미지 모두 제거
     */
    clearStyles(): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        (this.currentProject.styles as any[]).length = 0;
        console.log('🧹 Styles cleared');
    }

    /**
     * 모든 참조 이미지 제거 (Subject, Scene, Style)
     */
    clearAllReferences(): void {
        this.clearSubjects();
        this.clearScenes();
        this.clearStyles();
    }

    /**
     * 프로젝트의 모든 미디어 목록 조회 (리버스 엔지니어링된 API)
     * @param workflowId 프로젝트 ID (없으면 현재 프로젝트)
     */
    async getProjectMedia(workflowId?: string): Promise<ProjectMedia[]> {
        const projectId = workflowId || this.currentProject?.projectId;
        if (!projectId) {
            throw new Error('No project ID. Provide workflowId or call createProject() first.');
        }

        const cookie = this.whisk.account.getCookie();
        const input = encodeURIComponent(JSON.stringify({ json: { workflowId: projectId } }));
        const url = `https://labs.google/fx/api/trpc/media.getProjectWorkflow?input=${input}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: { 
                'Cookie': cookie,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to get project media: ${response.status}`);
        }

        const data = await response.json() as any;
        const mediaList = data?.result?.data?.json?.result?.media || [];

        return mediaList.map((m: any) => ({
            name: m.name,
            createTime: m.createTime,
            mediaCategory: m.backboneMetadata?.mediaCategory || 'MEDIA_CATEGORY_SUBJECT',
            mediaGenerationId: m.userUploadedImage?.mediaGenerationId || m.image?.mediaGenerationId || '',
            isUserUploaded: !!m.userUploadedImage,
            prompt: m.image?.prompt,
            mediaKey: m.mediaGenerationId?.mediaKey
        }));
    }

    /**
     * 기존에 업로드된 Subject를 참조로 선택 (업로드 없이!)
     * @param mediaGenerationId Whisk에 저장된 미디어 ID
     * @param caption 캡션 (없으면 빈 문자열)
     */
    selectExistingSubject(mediaGenerationId: string, caption: string = ''): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        (this.currentProject.subjects as any[]).push({
            prompt: caption,
            mediaGenerationId: mediaGenerationId
        });
        console.log(`🎭 Selected existing Subject: ${mediaGenerationId.substring(0, 30)}...`);
    }

    /**
     * 기존에 업로드된 Scene을 참조로 선택 (업로드 없이!)
     */
    selectExistingScene(mediaGenerationId: string, caption: string = ''): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        (this.currentProject.scenes as any[]).push({
            prompt: caption,
            mediaGenerationId: mediaGenerationId
        });
        console.log(`🏞️ Selected existing Scene: ${mediaGenerationId.substring(0, 30)}...`);
    }

    /**
     * 기존에 업로드된 Style을 참조로 선택 (업로드 없이!)
     */
    selectExistingStyle(mediaGenerationId: string, caption: string = ''): void {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }
        (this.currentProject.styles as any[]).push({
            prompt: caption,
            mediaGenerationId: mediaGenerationId
        });
        console.log(`🎨 Selected existing Style: ${mediaGenerationId.substring(0, 30)}...`);
    }

    /**
     * 카테고리별 기존 참조 선택
     */
    selectExistingReference(
        mediaGenerationId: string, 
        category: 'SUBJECT' | 'SCENE' | 'STYLE',
        caption: string = ''
    ): void {
        switch (category) {
            case 'SUBJECT':
                this.selectExistingSubject(mediaGenerationId, caption);
                break;
            case 'SCENE':
                this.selectExistingScene(mediaGenerationId, caption);
                break;
            case 'STYLE':
                this.selectExistingStyle(mediaGenerationId, caption);
                break;
        }
    }

    /**
     * 현재 참조 상태 확인
     */
    getReferenceStatus(): { subjects: number; scenes: number; styles: number } {
        if (!this.currentProject) {
            return { subjects: 0, scenes: 0, styles: 0 };
        }
        return {
            subjects: this.currentProject.subjects.length,
            scenes: this.currentProject.scenes.length,
            styles: this.currentProject.styles.length,
        };
    }

    /**
     * 참조 이미지를 사용해 이미지 생성 (재시도 로직 포함)
     */
    async generateWithReferences(prompt: string, maxRetries: number = 3): Promise<GenerationResult> {
        if (!this.currentProject) {
            throw new Error('No project created. Call createProject() first.');
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🖼️ [AI REQUEST] Whisk GenerateWithReferences (attempt ${attempt}): ${prompt.substring(0, 100)}...`);
                console.log(`   [AI REQUEST] References: S:${this.currentProject.subjects.length}, Sc:${this.currentProject.scenes.length}, St:${this.currentProject.styles.length}`);
                const media = await this.currentProject.generateImageWithReferences(prompt);

                if (media && media.encodedMedia && media.encodedMedia.length > 1000) {
                    console.log(`   [AI RESPONSE] SUCCESS (mediaId: ${media.mediaGenerationId}, size: ${media.encodedMedia.length})`);
                    return {
                        success: true,
                        imageBase64: media.encodedMedia,
                        mediaId: media.mediaGenerationId
                    };
                }

                if (attempt < maxRetries) {
                    console.warn(`[Whisk] 시도 ${attempt}: 응답 부족, 재시도...`);
                    await this.delay(3000 * attempt);
                    continue;
                }

                return { success: false, error: '생성된 이미지가 유효하지 않음' };

            } catch (error: any) {
                const isRateLimit = error.message?.includes('rate') || error.message?.includes('429');

                if (attempt < maxRetries) {
                    const waitTime = isRateLimit ? 15000 : 5000;
                    console.warn(`[Whisk] 시도 ${attempt}: ${error.message}, ${waitTime / 1000}초 후 재시도...`);
                    await this.delay(waitTime);
                    continue;
                }

                return { success: false, error: error.message };
            }
        }

        return { success: false, error: '최대 재시도 횟수 초과' };
    }

    /**
     * 참조 없이 일반 이미지 생성 (재시도 로직 포함)
     */
    async generate(prompt: string, maxRetries: number = 3): Promise<GenerationResult> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🖼️ [AI REQUEST] Whisk Generate (attempt ${attempt}): ${prompt.substring(0, 100)}...`);
                const results = await this.whisk.generateImage(prompt);

                if (results && results.length > 0 && results[0].encodedMedia) {
                    // base64 유효성 검증
                    const base64 = results[0].encodedMedia;
                    if (base64.length < 1000) {  // 비정상적으로 짧은 응답
                        console.warn(`   [AI RESPONSE] WARNING: 응답 크기 부족 (${base64.length} chars)`);
                        if (attempt < maxRetries) {
                            await this.delay(2000 * attempt);
                            continue;
                        }
                        return { success: false, error: '생성된 이미지 크기가 너무 작음' };
                    }

                    console.log(`   [AI RESPONSE] SUCCESS (mediaId: ${results[0].mediaGenerationId}, size: ${base64.length})`);
                    return {
                        success: true,
                        imageBase64: base64,
                        mediaId: results[0].mediaGenerationId
                    };
                }

                if (attempt < maxRetries) {
                    console.warn(`[Whisk] 시도 ${attempt}: 빈 응답, 재시도...`);
                    await this.delay(2000 * attempt);
                    continue;
                }

                return { success: false, error: 'No image generated' };

            } catch (error: any) {
                const isRateLimit = error.message?.includes('rate') || error.message?.includes('429');
                const isTimeout = error.message?.includes('timeout') || error.message?.includes('ETIMEDOUT');

                if (attempt < maxRetries && (isRateLimit || isTimeout)) {
                    const waitTime = isRateLimit ? 10000 : 5000;
                    console.warn(`[Whisk] 시도 ${attempt}: ${error.message}, ${waitTime / 1000}초 후 재시도...`);
                    await this.delay(waitTime);
                    continue;
                }

                return { success: false, error: error.message };
            }
        }

        return { success: false, error: '최대 재시도 횟수 초과' };
    }

    /**
     * 지연 헬퍼
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * base64 이미지를 파일로 저장
     */
    static saveImage(base64: string, outputPath: string): void {
        const buffer = Buffer.from(base64, 'base64');
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputPath, buffer);
    }

    /**
     * 프로젝트 삭제
     */
    async deleteProject(): Promise<void> {
        if (this.currentProject) {
            await this.currentProject.delete();
            this.currentProject = null;
        }
    }

    get project(): Project | null {
        return this.currentProject;
    }
}
