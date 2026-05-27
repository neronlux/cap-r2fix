import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const valuesMock = vi.hoisted(() => vi.fn());
const createUploadTargetForUserMock = vi.hoisted(() => vi.fn());
const createUploadTargetForVideoMock = vi.hoisted(() => vi.fn());
const getCurrentUserMock = vi.hoisted(() => vi.fn());
const requireOrganizationAccessMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());

const mockDb = vi.hoisted(() => ({
	insert: vi.fn(() => mockDb),
	values: valuesMock,
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "video-123"),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videoId" },
	videoUploads: { videoId: "videoId" },
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: false },
	NODE_ENV: "production",
	serverEnv: vi.fn(() => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		WEB_URL: "https://cap.test",
	})),
}));

vi.mock("@cap/utils", () => ({
	dub: vi.fn(() => ({
		links: { create: vi.fn() },
	})),
	userIsPro: vi.fn(() => true),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		createUploadTargetForUser: createUploadTargetForUserMock,
		createUploadTargetForVideo: createUploadTargetForVideoMock,
	},
}));

vi.mock("@cap/web-domain", () => ({
	Video: {
		VideoId: {
			make: vi.fn((value: string) => value),
		},
	},
}));

vi.mock("next/cache", () => ({
	revalidatePath: revalidatePathMock,
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: requireOrganizationAccessMock,
}));

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

describe("createVideoForServerProcessing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		valuesMock.mockResolvedValue(undefined);
		getCurrentUserMock.mockResolvedValue({
			id: "user-123",
			stripeSubscriptionStatus: "active",
		});
		requireOrganizationAccessMock.mockResolvedValue(undefined);
		createUploadTargetForUserMock.mockReturnValue(
			Effect.succeed({
				upload: {
					type: "put",
					url: "https://r2.example/upload",
					headers: { "Content-Type": "video/mp4" },
				},
				bucketId: { _tag: "None" },
				storageIntegrationId: { _tag: "None" },
			}),
		);
	});

	it("requests a presigned PUT upload target for browser video uploads", async () => {
		const { createVideoForServerProcessing } = await import(
			"@/actions/video/create-for-processing"
		);
		const orgId = "org-123" as Parameters<
			typeof createVideoForServerProcessing
		>[0]["orgId"];

		await createVideoForServerProcessing({
			duration: 42,
			resolution: "1920x1080",
			orgId,
		});

		expect(createUploadTargetForUserMock).toHaveBeenCalledWith(
			"user-123",
			"user-123/video-123/raw-upload.mp4",
			expect.objectContaining({
				contentType: "video/mp4",
				method: "put",
				fields: expect.objectContaining({
					"x-amz-meta-userid": "user-123",
					"x-amz-meta-duration": "42",
					"x-amz-meta-resolution": "1920x1080",
				}),
			}),
			"org-123",
		);
	});
});

describe("createVideoAndGetUploadUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		valuesMock.mockResolvedValue(undefined);
		getCurrentUserMock.mockResolvedValue({
			id: "user-123",
			stripeSubscriptionStatus: "active",
		});
		requireOrganizationAccessMock.mockResolvedValue(undefined);
		createUploadTargetForUserMock.mockReturnValue(
			Effect.succeed({
				upload: {
					type: "put",
					url: "https://r2.example/upload",
					headers: { "Content-Type": "video/mp4" },
				},
				bucketId: { _tag: "None" },
				storageIntegrationId: { _tag: "None" },
			}),
		);
	});

	it("requests a presigned PUT upload target for web recorder uploads", async () => {
		const { createVideoAndGetUploadUrl } = await import(
			"@/actions/video/upload"
		);
		const orgId = "org-123" as Parameters<
			typeof createVideoAndGetUploadUrl
		>[0]["orgId"];

		await createVideoAndGetUploadUrl({
			duration: 42,
			resolution: "1920x1080",
			orgId,
			supportsUploadProgress: true,
		});

		expect(createUploadTargetForUserMock).toHaveBeenCalledWith(
			"user-123",
			"user-123/video-123/result.mp4",
			expect.objectContaining({
				contentType: "video/mp4",
				method: "put",
				fields: expect.objectContaining({
					"x-amz-meta-userid": "user-123",
					"x-amz-meta-duration": "42",
					"x-amz-meta-resolution": "1920x1080",
				}),
			}),
			"org-123",
		);
	});
});
