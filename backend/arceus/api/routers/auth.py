"""Auth routes — TBD provider."""

from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup")
async def signup() -> dict:
    # TODO: implement when auth provider decided
    return {"message": "not implemented"}


@router.post("/login")
async def login() -> dict:
    return {"message": "not implemented"}


@router.post("/logout")
async def logout() -> dict:
    return {"message": "not implemented"}
