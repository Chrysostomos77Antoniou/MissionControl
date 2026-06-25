// Generate an image with Replicate FLUX (flux-schnell — fast & cheap) and
// return the raw bytes. Uses the model-prediction endpoint with `Prefer: wait`
// so the call resolves synchronously instead of requiring manual polling.
export async function generateImage(prompt: string): Promise<{ bytes: Buffer; contentType: string }> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN not set in .env.local.");

  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: "1:1",
          output_format: "webp",
          num_outputs: 1,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = (await res.json()) as { output?: string[] | string; error?: string };
  if (data.error) throw new Error(`Replicate error: ${data.error}`);
  const url = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!url) throw new Error("Replicate returned no image URL.");

  const img = await fetch(url);
  if (!img.ok) throw new Error(`Failed to fetch generated image (${img.status}).`);
  const bytes = Buffer.from(await img.arrayBuffer());
  return { bytes, contentType: "image/webp" };
}
