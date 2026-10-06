/** The picture Test connection shows a chat model, to find out whether it can
 *  see pictures at all (`probeLlmSource`, `endpoint-capabilities` § Picture
 *  input).
 *
 *  ⛔ WHY A NUMBER, AND WHY THIS ONE. The check has to tell a model that SAW the
 *  picture from one that answered without it — some endpoints accept an image,
 *  drop it, and let the model answer anyway. A four-digit number cannot be
 *  guessed (a blind model writes "I cannot see any picture" or some other
 *  number), and reading printed digits is the one thing every model that takes
 *  pictures does well.
 *
 *  ⛔ AND WHY A PLAIN FONT. The first version drew the digits from a 5×7 pixel
 *  font. Measured against a real model (qwen3.7-plus, 2026-10-04) it read
 *  "4027" twice and spent 2,000–5,000 reasoning tokens and 37–93 s deliberating
 *  over the blocky 8 — longer than the probe's whole time box. Rendered in a
 *  bold Arial it read "4827" 6 times out of 6 in 4–6 s. A test picture has to be
 *  easy for every model that can see, or it reports a working one as blind.
 *
 *  320×140, 8-bit grayscale PNG, 2,202 bytes: small enough to cost a few dozen
 *  image tokens, and above the sizes some providers refuse as too small. */
export const PROBE_PICTURE = {
  mime_type: 'image/png',
  /** What the picture shows. Compared on its digits only, so "4,827" or "The
   *  number is 4827." both count. */
  text: '4827',
  data_b64: ''
  + 'iVBORw0KGgoAAAANSUhEUgAAAUAAAACMCAAAAAAopi8NAAAIYUlEQVR42u2c3WtURxTA5x/Y133K'
  + '0z7sQx72YUEISEACEiQECUURMSAtlSimqKVdK1qT1mqCkYqfaCySRFRsrJ9YQjS1apCYZqlfSWjU'
  + '6KLRWk2MZnXN3ey05mvvmbnzcXdTd2445/Ge+bq/nTtz5pwzSyhKVkIQAQJEgAgQAaIgQASIABEg'
  + 'CgJEgAgQAaIgQASIABEgCgJEgAgQAaIgQASIABEgCgJEgAgQAaJ8NIBNa6Zl7UtpydHo2cadVWsj'
  + 'NQdOXHyu3X7yzpmGD7Vq65vbns5CgF3EJjfF5dqri+wlSXBF07C69RtVxaBWoOKoI/obx1xIi0kA'
  + '3+brABw9Pofw4os8krY9XB9yqEUq7/FFFxIX4jMJ4NdEA2CrX/QulW/Fn+5+n6jWkiezBuBVogZo'
  + 'bZS8TKhH0PKtAhmCi7ME4JuAGuDrQvnrnHNs+ZgCQnVyVgBcSZQArRLV+1x32tqVFNbNBoAtRA1w'
  + 'hfp9ejPgR8hu7wMc9KsBHtV4oXyLqdSjxeGs5wEuI0qA8TydNzoEK6WK9DgMexxgM1EDrHWNQnPW'
  + 'fpBN3gb41KcGaHFl8koilfO4p/vtlRJ+XRKPMgPoNwOg05hZgO2MPvznxDfawCAstlc6z7Ya3NUa'
  + 'sx627g6wio2ZAWwzAmAD0QC4AarrpneLpwug5pWt0hKm0W/fTS2om1iyGQH8xQhnwiOfDsAw0FaI'
  + 'd/Dzac0rZsGK2mpdZ/rrm1K07ZXIUtmOlSOAY84bJQsQUPYPibegA2nFEdjkScnRm+zTsraAJbDG'
  + 'DHfWHqID8D1Q7oVK4Gn5Lv28ElSay5wd4cT9Smesi0B7740A2Eu0AD4BynaoXG7XrUo/nwsqNTM9'
  + 'bwPaZRpjPQAWhMdGOFStAj2AkPMLqKyz68rTiwNskXW6ngLaIvVYb4MKl8zwSG8jegCHgDIlOe9G'
  + 'ph/3gzoFch75yqHG82dsAZw5gDeJJkC4iTBfz2a77uD04wtE8GlPyAi0K5VjBb7IwIgRABMhbYAF'
  + 'EvsVrO1pB2nsYHVFaWiKfC3beQz0V6IaazcoftWMoBL4UculAIG2Dq6jwLjgwhyJWOe5g9UVV+Ue'
  + 'tM8UQ03NE7sQcwYQGLPhXilAsM75ngn3EL+l2/tOwVnOWUD//tdGAIyDE+ntfilA6BdYatPcEztH'
  + 'pbJYZlpyJjRYg49RIwB+YR9TDZUDpFuBOhKfet4JNkffG93e+zSCWIKIQ2HKCICX7GOaY6kAPocv'
  + 'HGhJfHg6sI6JEGl3vxz6peRMom5gfySAQ+Cb7KYqgLSR800t4tyBwcEMT0Ar5aVL7WVXUyMALme3'
  + 'VRVAsdGdnkexDFdAEBXhpQOUjRkB8Aw4l1s6ABnngIOD/a5293sZ73ZCWhq4HFdQEwA+Bx9fL9UC'
  + 'mNwk5ZfXkdn6Swipl5Zud/Yc5hQgODzsonoAKe2T+Is3x7V7v0FcTcAikQWVO4AgWlaY1AYoCZRH'
  + '9Xu/63M1AS+DsrdMAPjY53D40gFo7RPmWfmbxjR772Zjdfly1yjIK1xIDQCYWuB0BtAAeC0kWwPD'
  + 'VzKbfwq7Dho8HSYABJ7dojFdgKnVKjNmvUbndzh+2+UVvrSXnU8NAAgPr/1UF+BmdZxxi7LzKMev'
  + 'MCmtMAIq/GYAwORcZ/+nCmCDTqRW5Uu4zvHz9ctr/CR1a+cC4A6QSJDSBdjG7Rplq8r41I3Druy/'
  + '/4z4VsVwQzPshska4B3RsUgOMMZMnbLOcfR/n2Cn1ENJ3+eU6VwKI/pV7gGOhkXzRQ7wG/je6anw'
  + 'jMlbXSvu+wTPr87Vkb2M5h5gNQhEpHQBxuFEO2LfnJnNRXjxptEhP1o13Heg+NHcA+wUx6alAA8T'
  + 'sTVrQeuwSsd4mpDvleOF+V1DOQf4NmgfT2PKLvfhyWzyqdNSzh7brsFtdUQjBDIu21w63UppzgFe'
  + 'IW5l8Xg9GD9exDZbrj4sODgT96jH+w6sHE1eBDgRr/1ZHpQFzkVy3KHjH/mWdXDAL3jQuwC3g2fc'
  + 'TU4Y9N7K91vPN3zGtdu8hHoX4Cp5ZndCESN3yDXXOpMlwBfc4GGAwKM0j28XRJgLWe1p3vn/h9Zw'
  + '22U5YZ4COF+RBwQABqQYxk+BPXrDrVX8bt4BGJZlt1FqyRKt+jn/QeCB5nAXuEn+MBogTMPkrus/'
  + 'kCRaDedz8eQnusdOUO2UlwF+IsvwZT01n4LJyV3xDGr/XUKHtpfCeICVchcyPGVEhMvY+Per/3cT'
  + 'O2bmVpcJAH+AeyjjL2AS7u23vaJcgy7CuqX/1zkuc4DXXAOcGPdZ+HC1xMMzGaafPHtzC6Abl6jP'
  + 'XbTgYwAc6xXLRfCipyef/jPhzWIwgODsYyZKblNtYfl97mKwL0DNX40AKBOpO4vJBfL/nlb1QRvH'
  + 'nk3+hrdgQgJxuCcCb4M98zZAzplcNZXK2yQJcuzSXyqCVB7FyqPeBviam0uhDc19Ay01xexz242u'
  + '9/6sAK7n3WreBaj15xGsl6CBZAVwYWapr4YC1Pz3A3vqQDKYHcCAiyR08wEKbyUybpY+kTfUNUAr'
  + 'Y/PHTIDs7V9nsV8BXJMdwJeu4u8eAKj8Dyf2LyfC2QGEQa6uWQDQKTAOpcZeeoRkB7DLOQfKywBp'
  + 'i9Qu8bVkce7mAV6S3jb2JkA6VCFGELoPy9ZlCbBZ7sT1JkBKL88XADjO3jIsyxLgIXB2pOYDHAAv'
  + '9JewXO86Pk+68CSfJVngCiAfaAGme7EHAOrLaNe+8mkr1z8ncmGYek4M+B/p+EB39N7gGPWm4B9x'
  + 'I0AEiAARIAoCRIAIEAGiIEAEiAARIAoCRIAIEAGiIEAEiAARIAoCRIAIEAGiIEAEiAARIAoCRIAI'
  + 'EAGiIEAEiAARIAoCnCn5F9YK+6o5JsNyAAAAAElFTkSuQmCC',
} as const;
