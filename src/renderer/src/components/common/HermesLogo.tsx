import icon from "../../assets/jingyuai-icon.png";

function HermesLogo({ size = 32 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={icon}
      width={size}
      height={size}
      className="rounded-xl"
      alt="JingYuAI"
    />
  );
}

export default HermesLogo;
