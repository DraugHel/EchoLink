import sharp from 'sharp';

export async function resizeImageBuffer(buffer, mimeType, maxWidth = 800) {
  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata.width <= maxWidth) {
      return buffer;
    }

    const resized = await sharp(buffer)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    return resized;
  } catch (error) {
    console.error('Image resize error:', error);
    return buffer;
  }
}