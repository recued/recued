# photo-attribution live-drive images

Derived from `skimage.data.astronaut()` — NASA photograph of astronaut Eileen
Collins, **public domain**. It is the only bundled scikit-image sample that
`face_recognition`'s HOG detector finds a face in, and it happens to contain TWO,
which is what makes a two-person group photo possible without shipping anyone's
private photographs.

- `event/group.jpg` — the whole frame: the group photo, two detectable faces.
- `roster/001 - Maggie.jpg`, `roster/002 - Tom.jpg` — each face cropped with a
  0.9×height margin and upscaled 2×. Both are needed: a tighter crop is NOT
  detectable, so the reference photo for a person can fail to enrol even though
  the same face is found in the group shot. That is a real property of the tool
  and the drive asserts the recovery, not just the happy path.

The names are fictional. The filenames carry the pack's `<key> - <Name>` roster
convention, space included, because a path with a space in it going through argv
is part of what the live drive exists to prove.
